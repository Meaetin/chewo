/**
 * The normalized chat protocol — what a chat *pane* speaks, as opposed to the
 * pty panes in `terminals.ts`.
 *
 * Same doctrine as `adapter/types.ts` and `agent-runner.ts`: the renderer never
 * sees a CLI's own wire format. Main translates (`claude-chat.ts` today,
 * `codex app-server` next) into the events below, so feature code never
 * branches on the agent — see AGENTS.md, 2026-07-29.
 *
 * Renderer-safe: no node imports in this file.
 *
 * Events are a stream; `reduceChat` folds them into the item list the UI
 * renders. Both live here so the fold can be tested without a DOM.
 */

import type { NormalizedMessage } from './adapter/types'
import type { AttachmentChip } from './attachments'
import type { ToolPatch } from './diff'

export type ChatAgent = 'claude' | 'codex'

/**
 * A shortcut the CLI itself proposes alongside a permission request — e.g.
 * "switch this session to acceptEdits". Rendered as the extra buttons on an
 * approval card, so the wording comes from the CLI rather than from us.
 */
export interface PermissionSuggestion {
  /** 'setMode' | 'addRules' | … — CLI-defined, so never switched on exhaustively */
  type: string
  mode?: string
  destination?: string
  /** Rule payloads vary by type; kept opaque and echoed back verbatim */
  rules?: unknown
}

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown; suggestion?: PermissionSuggestion }
  | { behavior: 'deny'; message?: string }

/**
 * `awaiting` is the only status the user can act on — it means a `can_use_tool`
 * request is parked in main waiting for an answer, and the agent is blocked
 * until one arrives.
 */
export type ToolStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'denied' | 'cancelled'

export interface ToolCall {
  /** The CLI's `tool_use_id` — the identity that links start, approval and result */
  toolUseId: string
  name: string
  /** The CLI's own human label when it sends one, e.g. "Write" */
  displayName?: string
  /** Arrives empty on the opening event and is filled in once the model finishes
   *  streaming its arguments, so the chip can appear before the input is known */
  input: unknown
  status: ToolStatus
  /** Set while `awaiting` — the token `chatRespond` must echo back */
  requestId?: string
  /** The CLI's one-line summary of the call, e.g. "note.txt" */
  description?: string
  /** The CLI says Allow/Deny must not be offered — this tool's card *is* its
   *  UI, and the user answers on the card (see `ask-user-question.ts`) */
  requiresUserInteraction?: boolean
  suggestions?: PermissionSuggestion[]
  result?: string
  /** The diff a file-editing tool applied, when it reported one. Set from the
   *  result, never from the input — it is what happened, not what was asked. */
  patch?: ToolPatch
  /** Non-null when the call belongs to a subagent, not the main thread */
  parentToolUseId?: string | null
}

export interface ChatTurnStats {
  costUsd?: number
  durationMs?: number
  isError: boolean
  /** The user pressed stop. Not a failure, and must not be reported as one. */
  cancelled?: boolean
}

export interface ChatSessionInfo {
  /** The CLI's conversation id — the same one the sidebar and `--resume` use */
  sessionId: string
  model: string
  cwd: string
  /** Names only, for the composer's `/` palette */
  slashCommands: string[]
  mcpServers: Array<{ name: string; status: string }>
}

export type AgentChatEvent =
  | { type: 'session'; info: ChatSessionInfo }
  /**
   * Slash commands, learned from the startup handshake rather than from
   * `system/init` — the CLI does not send that until the first turn begins, so
   * without this the composer's `/` palette is empty until you have already
   * sent a message you might have wanted to send as a command.
   */
  | { type: 'capabilities'; slashCommands: string[] }
  | { type: 'block_start'; blockId: string; block: 'text' | 'thinking' }
  | { type: 'block_delta'; blockId: string; text: string }
  | { type: 'block_end'; blockId: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_input'; toolUseId: string; input: unknown }
  | {
      type: 'tool_approval'
      toolUseId: string
      requestId: string
      description?: string
      /** The request's own copy of the arguments — authoritative, and the base
       *  an interactive tool's answers are merged into */
      input?: unknown
      requiresUserInteraction?: boolean
      suggestions: PermissionSuggestion[]
    }
  /** The user said no. Emitted before the CLI's own error result so the chip
   *  reads "denied" instead of implying the tool failed. */
  | { type: 'tool_denied'; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; result: string; isError: boolean; patch?: ToolPatch }
  /** The agent is working — drives the composer's stop button and the spinner */
  | { type: 'busy'; busy: boolean }
  | { type: 'turn_end'; stats: ChatTurnStats }
  | { type: 'notice'; tone: 'error' | 'info'; text: string }
  | { type: 'exit'; code: number }

// ---------- items (what the UI renders) ----------

export type ChatItem =
  /** `attachments` echo the composer's chips — the pasted blob went to the
   *  agent verbatim, but the bubble shows the chip, not the blob */
  | { kind: 'user'; id: string; text: string; attachments?: AttachmentChip[] }
  | { kind: 'text'; id: string; text: string; done: boolean }
  | { kind: 'thinking'; id: string; text: string; done: boolean }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string }
  | { kind: 'turn'; id: string; stats: ChatTurnStats }

export interface ChatState {
  items: ChatItem[]
  info: ChatSessionInfo | null
  busy: boolean
  /** Set once the child process is gone — the composer goes read-only */
  exitCode: number | null
}

export const emptyChatState = (): ChatState => ({
  items: [],
  info: null,
  busy: false,
  exitCode: null
})

/** Replace the item at `index`, leaving the rest of the array identity-stable. */
function replaceAt(items: ChatItem[], index: number, next: ChatItem): ChatItem[] {
  const out = items.slice()
  out[index] = next
  return out
}

/** Update the tool item carrying `toolUseId`; a no-op if we never saw it start. */
function patchTool(
  state: ChatState,
  toolUseId: string,
  patch: (call: ToolCall) => ToolCall
): ChatState {
  const index = state.items.findIndex((i) => i.kind === 'tool' && i.call.toolUseId === toolUseId)
  if (index === -1) return state
  const item = state.items[index] as Extract<ChatItem, { kind: 'tool' }>
  return { ...state, items: replaceAt(state.items, index, { ...item, call: patch(item.call) }) }
}

/**
 * Fold one event into the visible state. Pure and total: an event for a block
 * or tool we never saw open is dropped rather than throwing, because a chat
 * pane can be opened against a session that is already mid-turn.
 */
export function reduceChat(state: ChatState, event: AgentChatEvent): ChatState {
  switch (event.type) {
    case 'session':
      // `system/init` carries its own command list; keep whatever the
      // handshake already gave us if this one arrives empty.
      return {
        ...state,
        info: {
          ...event.info,
          slashCommands: event.info.slashCommands.length
            ? event.info.slashCommands
            : (state.info?.slashCommands ?? [])
        }
      }

    case 'capabilities':
      return {
        ...state,
        info: state.info
          ? { ...state.info, slashCommands: event.slashCommands }
          : {
              sessionId: '',
              model: '',
              cwd: '',
              slashCommands: event.slashCommands,
              mcpServers: []
            }
      }

    case 'block_start':
      return {
        ...state,
        items: [
          ...state.items,
          event.block === 'thinking'
            ? { kind: 'thinking', id: event.blockId, text: '', done: false }
            : { kind: 'text', id: event.blockId, text: '', done: false }
        ]
      }

    case 'block_delta': {
      const index = state.items.findIndex((i) => i.id === event.blockId)
      if (index === -1) return state
      const item = state.items[index]
      if (item.kind !== 'text' && item.kind !== 'thinking') return state
      return {
        ...state,
        items: replaceAt(state.items, index, { ...item, text: item.text + event.text })
      }
    }

    case 'block_end': {
      const index = state.items.findIndex((i) => i.id === event.blockId)
      if (index === -1) return state
      const item = state.items[index]
      if (item.kind !== 'text' && item.kind !== 'thinking') return state
      return { ...state, items: replaceAt(state.items, index, { ...item, done: true }) }
    }

    case 'tool_start':
      return {
        ...state,
        items: [...state.items, { kind: 'tool', id: event.call.toolUseId, call: event.call }]
      }

    case 'tool_input':
      return patchTool(state, event.toolUseId, (call) => ({ ...call, input: event.input }))

    case 'tool_approval':
      return patchTool(state, event.toolUseId, (call) => ({
        ...call,
        status: 'awaiting',
        requestId: event.requestId,
        description: event.description ?? call.description,
        // The request repeats the arguments; prefer them, but never clear what
        // the assistant message already established if this one omits them
        input: event.input ?? call.input,
        requiresUserInteraction: event.requiresUserInteraction,
        suggestions: event.suggestions
      }))

    case 'tool_denied':
      return patchTool(state, event.toolUseId, (call) => ({
        ...call,
        status: 'denied',
        requestId: undefined,
        suggestions: undefined
      }))

    case 'tool_result':
      return patchTool(state, event.toolUseId, (call) => ({
        ...call,
        // A denial comes back as an error result; keep the distinction so the
        // chip can say "denied" rather than implying the tool failed
        status: call.status === 'denied' ? 'denied' : event.isError ? 'error' : 'ok',
        requestId: undefined,
        suggestions: undefined,
        result: event.result,
        patch: event.patch ?? call.patch
      }))

    case 'busy':
      return { ...state, busy: event.busy }

    case 'turn_end': {
      // A tool in flight when the turn ends never gets its result — after an
      // interrupt the CLI simply stops. Without this its chip spins forever.
      const settled = state.items.map((item) =>
        item.kind === 'tool' && (item.call.status === 'running' || item.call.status === 'awaiting')
          ? { ...item, call: { ...item.call, status: 'cancelled' as const, requestId: undefined, suggestions: undefined } }
          : item
      )
      return {
        ...state,
        busy: false,
        items: [...settled, { kind: 'turn', id: `turn-${state.items.length}`, stats: event.stats }]
      }
    }

    case 'notice':
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'notice', id: `notice-${state.items.length}`, tone: event.tone, text: event.text }
        ]
      }

    case 'exit':
      return { ...state, busy: false, exitCode: event.code }
  }
}

/**
 * Turn a stored transcript into chat items.
 *
 * Resuming does not replay anything: `--resume` loads the conversation into the
 * CLI's own context and then stays silent until the next turn, so a resumed
 * pane would otherwise open blank on a conversation with hundreds of messages.
 * The history is read from the session file instead — the same parse the
 * transcript view uses, so a resumed pane and a read-only transcript agree.
 *
 * Ids are namespaced `seed-*` so they can never collide with the live
 * `messageId:index` and `tool_use_id` ids that follow.
 */
export function seedItems(messages: NormalizedMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  messages.forEach((m, i) => {
    const id = `seed-${i}`
    if (m.commandName) {
      items.push({ kind: 'user', id, text: `/${m.commandName}` })
    } else if (m.role === 'user') {
      items.push({ kind: 'user', id, text: m.text })
    } else if (m.role === 'assistant') {
      if (m.text) items.push({ kind: 'text', id, text: m.text, done: true })
    } else {
      items.push({
        kind: 'tool',
        id,
        call: {
          // Historical calls are settled by definition — nothing can be
          // approved or cancelled after the fact
          toolUseId: id,
          name: m.toolName ?? 'tool',
          input: m.text ? { command: m.text } : {},
          status: 'ok',
          result: m.toolResult,
          patch: m.toolPatch
        }
      })
    }
  })
  return items
}

/** The user's own message, appended locally on send — the CLI never echoes it back. */
export function appendUserMessage(
  state: ChatState,
  text: string,
  attachments?: AttachmentChip[]
): ChatState {
  return {
    ...state,
    items: [
      ...state.items,
      {
        kind: 'user',
        id: `user-${state.items.length}`,
        text,
        ...(attachments?.length ? { attachments } : {})
      }
    ]
  }
}

/** Tool calls parked on the user — the composer blocks sending while any exist. */
export function pendingApprovals(state: ChatState): ToolCall[] {
  return state.items
    .filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool')
    .map((i) => i.call)
    .filter((c) => c.status === 'awaiting')
}
