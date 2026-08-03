import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import type { AgentChatEvent, ApprovalDecision } from '../shared/agent-chat'
import { imageBlocks } from './attachments'
import { claudeChatArgs, createClaudeNormalizer } from './claude-chat'
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
 *    interpolated into a command string: `zsh -ilc 'claude "$@"' chewo …`.
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
  normalize: (raw: unknown) => AgentChatEvent[]
  cwd: string
  /** Bound from the CLI's `system/init`; the id the sidebar and `--resume` use */
  sessionId?: string
  /** stdout arrives in arbitrary chunks; JSON is newline-delimited */
  buffer: string
  /** can_use_tool requests parked on the user: request id → the tool they gate */
  awaiting: Map<string, string>
  /** Set by `interruptChat`, cleared by the turn it stops. The CLI reports an
   *  interrupted turn the same way it reports a failure, so this is the only
   *  way to tell "you pressed stop" from "something broke". */
  interrupted: boolean
  /** True until the agent's first line of JSON. While it holds, stderr is the
   *  setup script talking and every line is surfaced, not just failures. */
  setupPhase: boolean
}

const chats = new Map<number, ChatRecord>()

/** Our own handshake id, so its reply is not mistaken for a tool response. */
const INIT_REQUEST_ID = 'chewo-init'

export interface CreateChatOptions {
  /** Only 'claude' today; 'codex' arrives with the app-server backend */
  source: 'claude'
  cwd?: string | null
  sessionId?: string
  model?: string
  effort?: string
  permissionMode?: string
  extraDirs?: string[]
  /** Worktree setup (env copy, install) that must succeed before the agent
   *  starts. The user's own script, so it is shell by design — same contract
   *  as `buildCommand` in terminals.ts. */
  setupCommand?: string
}

function emit(win: BrowserWindow, id: number, event: AgentChatEvent): void {
  safeSend(win, 'chat:event', { id, event })
}

export function createChat(win: BrowserWindow, opts: CreateChatOptions): number {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  const args = claudeChatArgs({
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    sessionId: opts.sessionId,
    extraDirs: opts.extraDirs
  })

  // A setup script runs first and the agent only starts if it succeeds, same
  // as the pty path. Its stdout is redirected to stderr so it cannot corrupt
  // the JSON stream we parse, and `exec` hands the process straight to the
  // agent afterwards rather than leaving a shell in the middle.
  const setup = opts.setupCommand?.trim()
  const script = setup ? `{ ${setup} } 1>&2 && exec claude "$@"` : 'claude "$@"'

  // `$0` is a label only; the args after it become "$@" verbatim
  const proc = spawn('/bin/zsh', ['-ilc', script, 'chewo', ...args], {
    cwd,
    env: buildPtyEnv(process.env)
  }) as ChildProcessWithoutNullStreams

  const id = nextPaneId()
  const record: ChatRecord = {
    proc,
    normalize: createClaudeNormalizer(),
    cwd,
    sessionId: opts.sessionId,
    buffer: '',
    awaiting: new Map(),
    interrupted: false,
    setupPhase: Boolean(setup)
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

      // Answer to our startup handshake — the only place slash commands are
      // available before the first turn (see INIT_REQUEST_ID below)
      const reply = raw as {
        type?: string
        response?: { request_id?: string; response?: { commands?: Array<{ name?: string }> } }
      }
      if (reply.type === 'control_response' && reply.response?.request_id === INIT_REQUEST_ID) {
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
        record.awaiting.set(parsed.request_id, parsed.request.tool_use_id ?? '')

      for (const event of record.normalize(raw)) {
        if (event.type === 'session') record.sessionId = event.info.sessionId
        if (event.type === 'turn_end' && record.interrupted) {
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

  proc.on('error', (err) => {
    emit(win, id, { type: 'notice', tone: 'error', text: `Could not start claude: ${err.message}` })
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

  // The SDK-style handshake answers immediately with the command catalog,
  // which is what makes the composer's `/` palette work on the first turn.
  proc.stdin.write(
    JSON.stringify({
      type: 'control_request',
      request_id: INIT_REQUEST_ID,
      request: { subtype: 'initialize', hooks: {} }
    }) + '\n'
  )

  return id
}

/**
 * Send a user turn. Returns false when the pane's process is already gone.
 *
 * `images` are staged attachment paths, read here and inlined as base64
 * content blocks. A plain turn keeps sending a bare string rather than a
 * one-element array — same thing on the wire, but it keeps the common case
 * exactly as it was.
 */
export function sendChat(win: BrowserWindow, id: number, text: string, images?: string[]): boolean {
  const record = chats.get(id)
  if (!record) return false
  const blocks = images?.length ? imageBlocks(images) : []
  const content = blocks.length
    ? [...(text ? [{ type: 'text', text }] : []), ...blocks]
    : text
  record.proc.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
  )
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
  const toolUseId = record.awaiting.get(requestId) ?? ''
  record.awaiting.delete(requestId)

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

  record.proc.stdin.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    }) + '\n'
  )

  // The CLI reports a denial as an error tool_result; mark the chip first so it
  // reads "denied" rather than looking like the tool broke.
  if (decision.behavior === 'deny' && toolUseId)
    emit(win, id, { type: 'tool_denied', toolUseId })
}

/** Stop the turn in flight, keeping the session alive. */
export function interruptChat(id: number): void {
  const record = chats.get(id)
  if (!record) return
  record.interrupted = true
  record.proc.stdin.write(
    JSON.stringify({
      type: 'control_request',
      request_id: `interrupt-${Date.now()}`,
      request: { subtype: 'interrupt' }
    }) + '\n'
  )
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
