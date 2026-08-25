import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import type { AgentChatEvent, ApprovalDecision } from '../shared/agent-chat'
import { imageBlocks } from './attachments'
import { claudeChatArgs, createClaudeNormalizer } from './claude-chat'
import {
  CODEX_THREAD_ID,
  codexApprovalMessage,
  codexInterruptMessage,
  codexStartupMessages,
  codexTurnMessage,
  createCodexNormalizer,
  type CodexPendingRequest
} from './codex-chat'
import { nextPaneId } from './pane-ids'
import { safeSend } from './safe-send'
import { buildPtyEnv } from './terminals'

/**
 * Chat panes: the same agent CLIs the ptys run, driven over a JSON protocol
 * instead of a terminal, so the renderer can draw a real UI (SPEC §chat).
 *
 * Deliberately shaped like `terminals.ts` — one Map keyed by pane id, create /
 * send / kill, events pushed with `safeSend` — because the renderer treats the
 * two interchangeably and a session can be moved between them.
 *
 * Three things here are not obvious:
 *
 * 1. The child is spawned through a login shell for PATH (a packaged Electron
 *    app inherits none), but the argv is passed *through* zsh rather than
 *    interpolated into a command string: `zsh -ilc '<binary> "$@"' chewo …`.
 *    Nothing needs shell-quoting, so a project path with a quote in it cannot
 *    turn into a command injection the way string building invites.
 * 2. `buildPtyEnv` scrubs the inherited CLAUDE env vars, same as the ptys do —
 *    an inherited session env makes the child think it is a nested session and
 *    skip writing its session file, which would break the sidebar and resume.
 * 3. One process serves the whole conversation. stdin stays open across turns
 *    (verified: same session id, memory intact), so closing it ends the session.
 */

interface ChatRecord {
  proc: ChildProcessWithoutNullStreams
  source: 'claude' | 'codex'
  normalize?: (raw: unknown) => AgentChatEvent[]
  codex?: ReturnType<typeof createCodexNormalizer>
  cwd: string
  /** Bound from the provider's startup response; the id the sidebar and resume use. */
  sessionId?: string
  /** stdout arrives in arbitrary chunks; JSON is newline-delimited */
  buffer: string
  /** can_use_tool requests parked on the user: request id → the tool they gate */
  awaiting: Map<string, { toolUseId: string; codex?: CodexPendingRequest }>
  /** Set by `interruptChat`, cleared by the turn it stops. The CLI reports an
   *  interrupted turn the same way it reports a failure, so this is the only
   *  way to tell "you pressed stop" from "something broke". */
  interrupted: boolean
  /** True until the agent's first line of JSON. While it holds, stderr is the
   *  setup script talking and every line is surfaced, not just failures. */
  setupPhase: boolean
  /** JSON-RPC ids Chewo owns; server-initiated approval ids are echoed as-is. */
  nextRequestId: number
  /** What each client request does, so an RPC rejection can settle the turn. */
  codexRequests: Map<number, 'turn' | 'interrupt'>
  /** Stop can be pressed before app-server announces the turn id. */
  codexInterruptPending: boolean
  /** Both are the *current* settings, not the spawn ones: a live change moves
   *  them, and Codex carries them on every subsequent turn. */
  effort?: string
  model?: string
  /** A card run can submit the moment the pane mounts, before app-server has
   *  answered thread/start. Hold it rather than racing turn/start ahead. */
  pendingTurns: Array<{ text: string; images: string[] }>
}

const chats = new Map<number, ChatRecord>()

/** Our own handshake id, so its reply is not mistaken for a tool response. */
const INIT_REQUEST_ID = 'chewo-init'

export interface CreateChatOptions {
  source: 'claude' | 'codex'
  cwd?: string | null
  sessionId?: string
  model?: string
  effort?: string
  permissionMode?: string
  approvalPolicy?: string
  extraDirs?: string[]
  /** Worktree setup (env copy, install) that must succeed before the agent
   *  starts. The user's own script, so it is shell by design — same contract
   *  as `buildCommand` in terminals.ts. */
  setupCommand?: string
  /**
   * Resolved by the caller, not here: the roster comes from a capability scan
   * and this file owns process lifecycle, not inventory. Empty = a normal
   * session.
   */
  appendSystemPrompt?: string
  forwardSubagentText?: boolean
}

function emit(win: BrowserWindow, id: number, event: AgentChatEvent): void {
  safeSend(win, 'chat:event', { id, event })
}

export function createChat(win: BrowserWindow, opts: CreateChatOptions): number {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  const claude = opts.source === 'claude'
  const args = claude
    ? claudeChatArgs({
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        sessionId: opts.sessionId,
        extraDirs: opts.extraDirs,
        appendSystemPrompt: opts.appendSystemPrompt,
        forwardSubagentText: opts.forwardSubagentText
      })
    : ['app-server']

  // A setup script runs first and the agent only starts if it succeeds, same
  // as the pty path. Its stdout is redirected to stderr so it cannot corrupt
  // the JSON stream we parse, and `exec` hands the process straight to the
  // agent afterwards rather than leaving a shell in the middle.
  const setup = opts.setupCommand?.trim()
  const binary = claude ? 'claude' : 'codex'
  const script = setup ? `{ ${setup} } 1>&2 && exec ${binary} "$@"` : `${binary} "$@"`

  // `$0` is a label only; the args after it become "$@" verbatim
  const proc = spawn('/bin/zsh', ['-ilc', script, 'chewo', ...args], {
    cwd,
    env: buildPtyEnv(process.env)
  }) as ChildProcessWithoutNullStreams

  const id = nextPaneId()
  const record: ChatRecord = {
    proc,
    source: opts.source,
    ...(claude
      ? { normalize: createClaudeNormalizer() }
      : {
          codex: createCodexNormalizer({
            cwd,
            sessionId: opts.sessionId,
            model: opts.model,
            effort: opts.effort,
            approvalPolicy: opts.approvalPolicy,
            extraDirs: opts.extraDirs,
            developerInstructions: opts.appendSystemPrompt
          })
        }),
    cwd,
    sessionId: opts.sessionId,
    buffer: '',
    awaiting: new Map(),
    interrupted: false,
    setupPhase: Boolean(setup),
    nextRequestId: 10,
    codexRequests: new Map(),
    codexInterruptPending: false,
    effort: opts.effort,
    model: opts.model,
    pendingTurns: []
  }
  chats.set(id, record)

  proc.stdout.on('data', (chunk: Buffer) => {
    // The agent is talking, so anything further on stderr is a real problem
    record.setupPhase = false
    record.buffer += chunk.toString()
    let newline: number
    while ((newline = record.buffer.indexOf('\n')) !== -1) {
      const line = record.buffer.slice(0, newline)
      record.buffer = record.buffer.slice(newline + 1)
      if (!line.trim()) continue

      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        // The CLI prints the odd human banner before the JSONL starts
        continue
      }

      // Answer to Claude's startup handshake — the only place its slash
      // commands are available before the first turn (see INIT_REQUEST_ID).
      const reply = raw as {
        type?: string
        response?: { request_id?: string; response?: { commands?: Array<{ name?: string }> } }
      }
      if (claude && reply.type === 'control_response' && reply.response?.request_id === INIT_REQUEST_ID) {
        const commands = (reply.response.response?.commands ?? [])
          .map((c) => c.name)
          .filter((n): n is string => Boolean(n))
        if (commands.length) emit(win, id, { type: 'capabilities', slashCommands: commands })
        continue
      }

      // Remember which tool each parked request gates, so a denial can mark
      // that chip rather than guessing from the error result that follows
      const parsed = raw as {
        type?: string
        request_id?: string
        request?: { subtype?: string; tool_use_id?: string }
      }
      if (
        parsed.type === 'control_request' &&
        parsed.request?.subtype === 'can_use_tool' &&
        parsed.request_id
      )
        record.awaiting.set(parsed.request_id, { toolUseId: parsed.request.tool_use_id ?? '' })

      const rpc = raw as { id?: unknown; error?: { message?: string } }
      const requestId = typeof rpc.id === 'number' ? rpc.id : undefined
      const requestKind = requestId === undefined ? undefined : record.codexRequests.get(requestId)
      if (requestId !== undefined) record.codexRequests.delete(requestId)

      const normalized = record.codex?.normalize(raw)
      if (normalized?.pending)
        record.awaiting.set(normalized.pending.key, {
          toolUseId: normalized.pending.toolUseId,
          codex: normalized.pending
        })
      const events = normalized?.events ?? record.normalize?.(raw) ?? []
      if (requestKind === 'turn' && rpc.error) {
        events.push({ type: 'turn_end', stats: { isError: true } })
      } else if (rpc.id === CODEX_THREAD_ID && rpc.error && record.pendingTurns.length) {
        record.pendingTurns = []
        events.push({ type: 'turn_end', stats: { isError: true } })
      }

      if (record.codexInterruptPending && record.codex) {
        const threadId = record.codex.threadId()
        const turnId = record.codex.turnId()
        if (threadId && turnId) sendCodexInterrupt(record, threadId, turnId)
      }

      for (const event of events) {
        if (event.type === 'session') record.sessionId = event.info.sessionId
        if (event.type === 'session' && record.codex && record.pendingTurns.length) {
          const threadId = record.codex.threadId()
          if (threadId) {
            for (const turn of record.pendingTurns) startCodexTurn(record, threadId, turn)
            record.pendingTurns = []
          }
        }
        if (event.type === 'turn_end') record.codexInterruptPending = false
        if (record.source === 'claude' && event.type === 'turn_end' && record.interrupted) {
          record.interrupted = false
          emit(win, id, { type: 'turn_end', stats: { ...event.stats, cancelled: true } })
          continue
        }
        emit(win, id, event)
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (!text) return
    // During setup this is the script's own output — an install the user is
    // waiting on, so show all of it. Afterwards a login shell is just chatty
    // (job control, rc warnings), so only real failures are worth surfacing.
    if (record.setupPhase) emit(win, id, { type: 'notice', tone: 'info', text: text.slice(0, 2000) })
    else if (/error|not found|denied|fatal/i.test(text))
      emit(win, id, { type: 'notice', tone: 'error', text: text.slice(0, 500) })
  })

  // A missing CLI can close between spawn and the startup writes below. The
  // process close/error handlers own the user-facing failure; do not let an
  // EPIPE on stdin become an uncaught main-process error first.
  proc.stdin.on('error', () => undefined)

  proc.on('error', (err) => {
    emit(win, id, { type: 'notice', tone: 'error', text: `Could not start ${opts.source}: ${err.message}` })
    emit(win, id, { type: 'exit', code: -1 })
    chats.delete(id)
  })

  proc.on('close', (code) => {
    emit(win, id, { type: 'exit', code: code ?? 0 })
    chats.delete(id)
  })

  // Nothing may be emitted synchronously here: `createChat` returns through
  // IPC before the renderer mounts the pane, so an event sent now has no
  // listener. Spawn-time facts (cwd) reach the pane as props instead; anything
  // the child tells us later arrives long after mount.

  if (claude)
    // The SDK-style handshake answers immediately with Claude's command catalog.
    writeJson(record, {
      type: 'control_request',
      request_id: INIT_REQUEST_ID,
      request: { subtype: 'initialize', hooks: {} }
    })
  else
    for (const message of codexStartupMessages({
      cwd,
      sessionId: opts.sessionId,
      model: opts.model,
      effort: opts.effort,
      approvalPolicy: opts.approvalPolicy,
      extraDirs: opts.extraDirs,
      developerInstructions: opts.appendSystemPrompt
    }))
      writeJson(record, message)

  return id
}

function writeJson(record: ChatRecord, message: unknown): void {
  record.proc.stdin.write(`${JSON.stringify(message)}\n`)
}

function startCodexTurn(
  record: ChatRecord,
  threadId: string,
  turn: { text: string; images: string[] }
): void {
  const requestId = record.nextRequestId++
  record.codexRequests.set(requestId, 'turn')
  writeJson(
    record,
    codexTurnMessage(requestId, threadId, turn.text, turn.images, record.effort, record.model)
  )
}

function sendCodexInterrupt(record: ChatRecord, threadId: string, turnId: string): void {
  const requestId = record.nextRequestId++
  record.codexRequests.set(requestId, 'interrupt')
  record.codexInterruptPending = false
  writeJson(record, codexInterruptMessage(requestId, threadId, turnId))
}

/**
 * Send a user turn. Returns false when the pane's process is already gone.
 *
 * `images` are staged attachment paths. Claude gets inlined base64 content;
 * Codex app-server gets localImage inputs. A plain Claude turn keeps sending a
 * bare string rather than a one-element array, preserving its common wire case.
 */
export function sendChat(win: BrowserWindow, id: number, text: string, images?: string[]): boolean {
  const record = chats.get(id)
  if (!record) return false
  if (record.codex) {
    const turn = { text, images: images ?? [] }
    const threadId = record.codex.threadId()
    if (threadId) startCodexTurn(record, threadId, turn)
    else record.pendingTurns.push(turn)
    emit(win, id, { type: 'busy', busy: true })
    return true
  }
  const blocks = images?.length ? imageBlocks(images) : []
  const content = blocks.length
    ? [...(text ? [{ type: 'text', text }] : []), ...blocks]
    : text
  writeJson(record, { type: 'user', message: { role: 'user', content } })
  emit(win, id, { type: 'busy', busy: true })
  return true
}

/**
 * Answer a parked `can_use_tool` request. The agent is blocked until this
 * arrives, so an unanswered request is a hung turn — which is why `killChat`
 * does not try to be polite about them.
 */
export function respondChat(
  win: BrowserWindow,
  id: number,
  requestId: string,
  decision: ApprovalDecision
): void {
  const record = chats.get(id)
  if (!record || !record.awaiting.has(requestId)) return
  const awaiting = record.awaiting.get(requestId)!
  const toolUseId = awaiting.toolUseId
  record.awaiting.delete(requestId)

  if (awaiting.codex) {
    writeJson(record, codexApprovalMessage(awaiting.codex, decision))
    if (decision.behavior === 'deny' && toolUseId)
      emit(win, id, { type: 'tool_denied', toolUseId })
    return
  }

  // `suggestion` is the CLI's own proposal echoed back verbatim (e.g. "switch
  // this session to acceptEdits"). Returning it in `updatedPermissions` is what
  // makes "Always allow" stick — the CLI stops asking, and it owns that state
  // rather than us keeping a shadow allowlist (verified against 2.1.220).
  const response =
    decision.behavior === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? {},
          ...(decision.suggestion ? { updatedPermissions: [decision.suggestion] } : {})
        }
      : { behavior: 'deny', message: decision.message ?? 'Denied by the user.' }

  writeJson(record, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response }
  })

  // The CLI reports a denial as an error tool_result; mark the chip first so it
  // reads "denied" rather than looking like the tool broke.
  if (decision.behavior === 'deny' && toolUseId)
    emit(win, id, { type: 'tool_denied', toolUseId })
}

/**
 * Move a running session onto another model.
 *
 * The two CLIs answer this in completely different places, which is why it is
 * one function rather than a flag someone remembers to pass twice. Claude
 * takes a `set_model` control request and then re-announces itself with a
 * fresh `system/init` carrying the new model — so the pane's own readout
 * updates without us echoing anything. Codex has no such request: `turn/start`
 * takes a `model` its schema calls an override "for this turn and subsequent
 * turns", so the choice is held here and travels with the next turn.
 *
 * Verified 2026-08-25 against Claude 2.1.240 and codex-cli 0.144.5.
 */
export function setChatModel(id: number, model: string): boolean {
  const record = chats.get(id)
  if (!record) return false
  record.model = model
  if (record.codex) return true
  writeJson(record, {
    type: 'control_request',
    request_id: `set-model-${Date.now()}`,
    // An empty pick means the CLI's own default, which is what its schema
    // reads a null model as — never the string 'default' spelled out here.
    request: { subtype: 'set_model', model: model || null }
  })
  return true
}

/**
 * Move a running session onto another reasoning effort.
 *
 * Claude has no control request for this — only the `/effort <level>` command,
 * which the CLI handles locally: it answers with one confirmation line and
 * never reaches a model (verified 2.1.240). That confirmation is left in the
 * thread on purpose, because it is the only acknowledgement there is. Codex
 * carries effort on `turn/start` exactly like the model above.
 */
export function setChatEffort(id: number, effort: string): boolean {
  const record = chats.get(id)
  if (!record) return false
  record.effort = effort
  if (record.codex) return true
  if (!effort) return true
  writeJson(record, { type: 'user', message: { role: 'user', content: `/effort ${effort}` } })
  return true
}

/** Stop the turn in flight, keeping the session alive. */
export function interruptChat(id: number): void {
  const record = chats.get(id)
  if (!record) return
  if (record.codex) {
    const threadId = record.codex.threadId()
    const turnId = record.codex.turnId()
    if (threadId && turnId) sendCodexInterrupt(record, threadId, turnId)
    else record.codexInterruptPending = true
    return
  }
  record.interrupted = true
  writeJson(record, {
    type: 'control_request',
    request_id: `interrupt-${Date.now()}`,
    request: { subtype: 'interrupt' }
  })
}

export function killChat(id: number): void {
  const record = chats.get(id)
  if (!record) return
  record.proc.stdin.end()
  record.proc.kill()
  chats.delete(id)
}

/** The CLI conversation id, once bound — what "open this in a terminal" resumes. */
export function chatSessionId(id: number): string | undefined {
  return chats.get(id)?.sessionId
}

export function chatCwd(id: number): string | undefined {
  return chats.get(id)?.cwd
}

export function disposeAllChats(): void {
  for (const record of chats.values()) {
    record.proc.stdin.end()
    record.proc.kill()
  }
  chats.clear()
}
