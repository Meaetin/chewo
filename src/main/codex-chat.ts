/**
 * Codex app-server JSON-RPC → Chewo's normalized chat protocol.
 *
 * The app-server is Codex's supported integration seam for custom clients. It
 * owns threads, turns, approvals and account state; this adapter keeps those
 * wire details out of the renderer and out of provider-neutral session code.
 */

import type {
  AgentChatEvent,
  ApprovalDecision,
  ChatSessionInfo,
  PermissionSuggestion,
  ToolCall
} from '../shared/agent-chat'
import { parseToolPatch, type ToolPatch, type DiffHunk } from '../shared/diff'
import type { AgentTask, TaskStatus } from '../shared/tool-tasks'

export const CODEX_INITIALIZE_ID = 0
export const CODEX_THREAD_ID = 1

type RpcId = string | number

interface WireMessage {
  id?: RpcId
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface CodexItem {
  type?: string
  id?: string
  text?: string
  phase?: string | null
  summary?: string[]
  content?: string[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
  changes?: Array<{ path?: string; kind?: unknown; diff?: string }>
  server?: string
  tool?: unknown
  arguments?: unknown
  result?: unknown
  error?: { message?: string } | null
  query?: string
  path?: string
  contentItems?: unknown
  success?: boolean | null
}

export type CodexPendingRequest =
  | {
      key: string
      wireId: RpcId
      toolUseId: string
      kind: 'command' | 'file'
    }
  | {
      key: string
      wireId: RpcId
      toolUseId: string
      kind: 'question'
      questions: Array<{ id: string; question: string }>
    }

export interface CodexNormalizeResult {
  events: AgentChatEvent[]
  pending?: CodexPendingRequest
}

export interface CodexChatOptions {
  cwd: string
  sessionId?: string
  model?: string
  effort?: string
  approvalPolicy?: string
  extraDirs?: string[]
  developerInstructions?: string
}

/** Messages sent once, in order, when the stdio connection opens. */
export function codexStartupMessages(opts: CodexChatOptions): unknown[] {
  const thread = {
    ...(opts.model ? { model: opts.model } : {}),
    cwd: opts.cwd,
    ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
    ...(opts.extraDirs?.length
      ? { runtimeWorkspaceRoots: [...new Set([opts.cwd, ...opts.extraDirs])] }
      : {}),
    ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {})
  }
  return [
    {
      method: 'initialize',
      id: CODEX_INITIALIZE_ID,
      params: {
        clientInfo: { name: 'chewo', title: 'Chewo', version: '1' },
        capabilities: { experimentalApi: true }
      }
    },
    { method: 'initialized', params: {} },
    opts.sessionId
      ? { method: 'thread/resume', id: CODEX_THREAD_ID, params: { threadId: opts.sessionId, ...thread } }
      : { method: 'thread/start', id: CODEX_THREAD_ID, params: thread }
  ]
}

const safeJson = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function unifiedPatch(change: { path?: string; kind?: unknown; diff?: string }): ToolPatch | undefined {
  if (!change.path || !change.diff) return undefined
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of change.diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (current && /^[ +\-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'))
      current.lines.push(line)
  }
  if (!hunks.length) return undefined
  const kind = change.kind as { type?: string } | undefined
  const patch = parseToolPatch({ filePath: change.path, structuredPatch: hunks })
  return patch ? { ...patch, ...(kind?.type === 'add' ? { created: true } : {}) } : undefined
}

function toolCall(item: CodexItem): ToolCall | null {
  if (!item.id) return null
  switch (item.type) {
    case 'commandExecution':
      return {
        toolUseId: item.id,
        name: 'shell',
        displayName: 'Shell',
        input: { command: item.command ?? '', cwd: item.cwd ?? '' },
        status: 'running'
      }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean)
      return {
        toolUseId: item.id,
        name: 'apply_patch',
        displayName: 'Edit',
        input: paths.length ? { path: paths[0], ...(paths.length > 1 ? { paths } : {}) } : {},
        status: 'running'
      }
    }
    case 'mcpToolCall':
      return {
        toolUseId: item.id,
        name: typeof item.tool === 'string' ? item.tool : 'mcp',
        displayName: [item.server, item.tool].filter((v) => typeof v === 'string').join(' · ') || 'MCP',
        input: item.arguments ?? {},
        status: 'running'
      }
    case 'dynamicToolCall':
      return {
        toolUseId: item.id,
        name: typeof item.tool === 'string' ? item.tool : 'tool',
        input: item.arguments ?? {},
        status: 'running'
      }
    case 'webSearch':
      return {
        toolUseId: item.id,
        name: 'web_search',
        displayName: 'Web search',
        input: { query: item.query ?? '' },
        status: 'running'
      }
    case 'imageView':
      return {
        toolUseId: item.id,
        name: 'view_image',
        displayName: 'View image',
        input: { path: item.path ?? '' },
        status: 'running'
      }
    case 'collabAgentToolCall':
      return {
        toolUseId: item.id,
        name: typeof item.tool === 'string' ? item.tool : 'Agent',
        input: item,
        status: 'running'
      }
    default:
      return null
  }
}

const taskStatus = (status: unknown): TaskStatus =>
  status === 'completed' ? 'completed' : status === 'inProgress' ? 'in_progress' : 'pending'

/** Stateful normalizer for one app-server connection. */
export function createCodexNormalizer(opts: CodexChatOptions): {
  normalize: (raw: unknown) => CodexNormalizeResult
  threadId: () => string | undefined
  turnId: () => string | undefined
} {
  let activeThreadId = opts.sessionId
  let activeTurnId: string | undefined
  const openBlocks = new Map<string, { kind: 'text' | 'thinking'; text: string }>()
  const tools = new Set<string>()

  const ensureBlock = (id: string, kind: 'text' | 'thinking', out: AgentChatEvent[]): void => {
    if (openBlocks.has(id)) return
    openBlocks.set(id, { kind, text: '' })
    out.push({ type: 'block_start', blockId: id, block: kind })
  }

  const addDelta = (id: string, kind: 'text' | 'thinking', delta: string, out: AgentChatEvent[]): void => {
    if (!delta) return
    ensureBlock(id, kind, out)
    const open = openBlocks.get(id)!
    open.text += delta
    out.push({ type: 'block_delta', blockId: id, text: delta })
  }

  const finishBlock = (
    id: string,
    kind: 'text' | 'thinking',
    finalText: string,
    out: AgentChatEvent[]
  ): void => {
    ensureBlock(id, kind, out)
    const open = openBlocks.get(id)!
    if (finalText && finalText.startsWith(open.text)) addDelta(id, kind, finalText.slice(open.text.length), out)
    out.push({ type: 'block_end', blockId: id })
    openBlocks.delete(id)
  }

  const ensureTool = (item: CodexItem, out: AgentChatEvent[]): void => {
    const call = toolCall(item)
    if (!call || tools.has(call.toolUseId)) return
    tools.add(call.toolUseId)
    out.push({ type: 'tool_start', call })
  }

  return {
    threadId: () => activeThreadId,
    turnId: () => activeTurnId,
    normalize(raw: unknown): CodexNormalizeResult {
      if (!raw || typeof raw !== 'object') return { events: [] }
      const msg = raw as WireMessage
      const out: AgentChatEvent[] = []

      if (msg.id === CODEX_THREAD_ID) {
        if (msg.error?.message)
          return { events: [{ type: 'notice', tone: 'error', text: msg.error.message }] }
        const thread = msg.result?.thread as Record<string, unknown> | undefined
        const id = typeof thread?.id === 'string' ? thread.id : opts.sessionId ?? ''
        activeThreadId = id || activeThreadId
        const info: ChatSessionInfo = {
          sessionId: id,
          model: typeof msg.result?.model === 'string' ? msg.result.model : opts.model ?? '',
          cwd: typeof msg.result?.cwd === 'string' ? msg.result.cwd : opts.cwd,
          // Slash commands are TUI client actions. App-server does not expose
          // a command catalog, so advertising those strings here would promise
          // commands that a turn/start request cannot execute.
          slashCommands: [],
          mcpServers: []
        }
        return { events: [{ type: 'session', info }] }
      }

      const responseTurn = msg.result?.turn as { id?: unknown } | undefined
      if (typeof responseTurn?.id === 'string') activeTurnId = responseTurn.id

      if (msg.error?.message && msg.id !== undefined)
        return { events: [{ type: 'notice', tone: 'error', text: msg.error.message }] }

      const params = msg.params ?? {}
      const item = params.item as CodexItem | undefined
      switch (msg.method) {
        case 'turn/started': {
          const turn = params.turn as { id?: string } | undefined
          activeTurnId = turn?.id
          return { events: [] }
        }
        case 'turn/completed': {
          const turn = params.turn as
            | { id?: string; status?: string; error?: { message?: string } | null; durationMs?: number | null }
            | undefined
          activeTurnId = undefined
          if (turn?.status === 'failed' && turn.error?.message)
            out.push({ type: 'notice', tone: 'error', text: turn.error.message })
          out.push({
            type: 'turn_end',
            stats: {
              durationMs: typeof turn?.durationMs === 'number' ? turn.durationMs : undefined,
              isError: turn?.status === 'failed',
              cancelled: turn?.status === 'interrupted'
            }
          })
          return { events: out }
        }
        case 'thread/tokenUsage/updated': {
          const usage = params.tokenUsage as
            | { last?: { inputTokens?: number }; modelContextWindow?: number | null }
            | undefined
          return {
            events: [{
              type: 'usage',
              usage: {
                contextTokens: usage?.last?.inputTokens,
                contextWindow:
                  typeof usage?.modelContextWindow === 'number' ? usage.modelContextWindow : undefined
              }
            }]
          }
        }
        case 'turn/plan/updated': {
          const plan = Array.isArray(params.plan) ? params.plan : []
          const tasks: AgentTask[] = plan.slice(0, 60).flatMap((entry, index) => {
            if (!entry || typeof entry !== 'object') return []
            const p = entry as { step?: unknown; status?: unknown }
            if (typeof p.step !== 'string' || !p.step) return []
            return [{ id: `codex-plan-${index}`, subject: p.step, status: taskStatus(p.status) }]
          })
          return { events: [{ type: 'tasks', tasks }] }
        }
        case 'item/started':
          if (!item?.id) return { events: [] }
          if (item.type === 'agentMessage') ensureBlock(item.id, 'text', out)
          else if (item.type === 'reasoning') ensureBlock(item.id, 'thinking', out)
          else ensureTool(item, out)
          return { events: out }
        case 'item/agentMessage/delta':
          addDelta(String(params.itemId ?? ''), 'text', String(params.delta ?? ''), out)
          return { events: out }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          addDelta(String(params.itemId ?? ''), 'thinking', String(params.delta ?? ''), out)
          return { events: out }
        case 'item/reasoning/summaryPartAdded': {
          const id = String(params.itemId ?? '')
          const open = openBlocks.get(id)
          if (open?.text && !open.text.endsWith('\n')) addDelta(id, 'thinking', '\n', out)
          return { events: out }
        }
        case 'item/completed': {
          if (!item?.id) return { events: [] }
          if (item.type === 'agentMessage') {
            finishBlock(item.id, 'text', item.text ?? '', out)
            return { events: out }
          }
          if (item.type === 'reasoning') {
            finishBlock(item.id, 'thinking', [...(item.summary ?? []), ...(item.content ?? [])].join('\n'), out)
            return { events: out }
          }
          if (item.type === 'plan') {
            finishBlock(item.id, 'text', item.text ?? '', out)
            return { events: out }
          }
          ensureTool(item, out)
          if (!tools.has(item.id)) return { events: out }
          if (item.type === 'commandExecution')
            out.push({
              type: 'tool_result',
              toolUseId: item.id,
              result: item.aggregatedOutput ?? '',
              isError: item.status === 'failed' || item.status === 'declined'
            })
          else if (item.type === 'fileChange') {
          const patch = item.changes?.length ? unifiedPatch(item.changes[0]) : undefined
            out.push({
              type: 'tool_result',
              toolUseId: item.id,
              result:
                item.status === 'completed'
                  ? item.changes && item.changes.length > 1
                    ? `Changed ${item.changes.length} files; previewing the first.`
                    : ''
                  : `File change ${item.status ?? 'finished'}`,
              isError: item.status === 'failed' || item.status === 'declined',
              ...(patch ? { patch } : {})
            })
          } else if (item.type === 'mcpToolCall')
            out.push({
              type: 'tool_result',
              toolUseId: item.id,
              result: item.error?.message ?? safeJson(item.result),
              isError: Boolean(item.error)
            })
          else
            out.push({
              type: 'tool_result',
              toolUseId: item.id,
              result: safeJson(item.contentItems ?? item.result),
              isError: item.success === false || item.status === 'failed'
            })
          return { events: out }
        }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
          if (msg.id === undefined) return { events: [] }
          const toolUseId = String(params.itemId ?? '')
          const pseudo: CodexItem =
            msg.method === 'item/commandExecution/requestApproval'
              ? {
                  id: toolUseId,
                  type: 'commandExecution',
                  command: String(params.command ?? ''),
                  cwd: String(params.cwd ?? '')
                }
              : { id: toolUseId, type: 'fileChange', changes: [] }
          ensureTool(pseudo, out)
          const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
          const canPersist =
            msg.method === 'item/fileChange/requestApproval' || available.includes('acceptForSession')
          const suggestions: PermissionSuggestion[] = canPersist
            ? [{ type: 'codexAcceptForSession', label: 'Allow for this session' }]
            : []
          const key = String(msg.id)
          out.push({
            type: 'tool_approval',
            toolUseId,
            requestId: key,
            description: typeof params.reason === 'string' ? params.reason : undefined,
            input:
              msg.method === 'item/commandExecution/requestApproval'
                ? { command: params.command, cwd: params.cwd }
                : undefined,
            suggestions
          })
          return {
            events: out,
            pending: {
              key,
              wireId: msg.id,
              toolUseId,
              kind: msg.method === 'item/commandExecution/requestApproval' ? 'command' : 'file'
            }
          }
        }
        case 'item/tool/requestUserInput': {
          if (msg.id === undefined) return { events: [] }
          const toolUseId = String(params.itemId ?? `question-${msg.id}`)
          const rawQuestions = Array.isArray(params.questions) ? params.questions : []
          const questions = rawQuestions.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return []
            const q = entry as Record<string, unknown>
            if (typeof q.id !== 'string' || typeof q.question !== 'string') return []
            return [{ id: q.id, question: q.question }]
          })
          if (!tools.has(toolUseId)) {
            tools.add(toolUseId)
            out.push({
              type: 'tool_start',
              call: {
                toolUseId,
                name: 'request_user_input',
                displayName: 'Question',
                input: {
                  questions: rawQuestions.map((entry) => {
                    const q = entry as Record<string, unknown>
                    return {
                      question: q.question,
                      header: q.header,
                      options: q.options,
                      multiSelect: false
                    }
                  })
                },
                status: 'running'
              }
            })
          }
          const key = String(msg.id)
          out.push({
            type: 'tool_approval',
            toolUseId,
            requestId: key,
            input: {
              questions: rawQuestions.map((entry) => {
                const q = entry as Record<string, unknown>
                return { question: q.question, header: q.header, options: q.options }
              })
            },
            requiresUserInteraction: true,
            suggestions: []
          })
          return {
            events: out,
            pending: { key, wireId: msg.id, toolUseId, kind: 'question', questions }
          }
        }
        case 'error': {
          // Retry progress is operational noise. The terminal logs it, and a
          // final failed turn carries the actionable error once retries end.
          if (params.willRetry === true) return { events: [] }
          const error = params.error as { message?: string } | undefined
          return error?.message
            ? { events: [{ type: 'notice', tone: 'error', text: error.message }] }
            : { events: [] }
        }
        case 'warning':
        case 'configWarning': {
          const text = String(params.message ?? params.summary ?? '')
          return text ? { events: [{ type: 'notice', tone: 'info', text }] } : { events: [] }
        }
        default:
          return { events: [] }
      }
    }
  }
}

/**
 * `model` and `effort` are overrides the app-server applies to this turn *and
 * every turn after it* — its own wording in the generated protocol schema. So
 * a live change costs no restart: it is put on the next turn and stays.
 */
export function codexTurnMessage(
  id: number,
  threadId: string,
  text: string,
  images: string[],
  effort?: string,
  model?: string
): unknown {
  return {
    method: 'turn/start',
    id,
    params: {
      threadId,
      input: [
        ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
        ...images.map((path) => ({ type: 'localImage', path }))
      ],
      ...(effort ? { effort } : {}),
      ...(model ? { model } : {})
    }
  }
}

export function codexInterruptMessage(id: number, threadId: string, turnId: string): unknown {
  return { method: 'turn/interrupt', id, params: { threadId, turnId } }
}

export function codexApprovalMessage(
  pending: CodexPendingRequest,
  decision: ApprovalDecision
): unknown {
  if (pending.kind === 'question') {
    const byText =
      decision.behavior === 'allow' && decision.updatedInput && typeof decision.updatedInput === 'object'
        ? ((decision.updatedInput as { answers?: Record<string, string> }).answers ?? {})
        : {}
    const answers = Object.fromEntries(
      pending.questions.map((q) => [q.id, { answers: byText[q.question] ? [byText[q.question]] : [] }])
    )
    return { id: pending.wireId, result: { answers } }
  }
  const persist = decision.behavior === 'allow' && decision.suggestion?.type === 'codexAcceptForSession'
  const answer = decision.behavior === 'allow' ? (persist ? 'acceptForSession' : 'accept') : 'decline'
  return { id: pending.wireId, result: { decision: answer } }
}
