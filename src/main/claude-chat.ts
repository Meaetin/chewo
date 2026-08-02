/**
 * Claude Code's stream-json wire format → the normalized chat protocol.
 *
 * Everything CLI-specific about chat panes lives here; `chat-sessions.ts` owns
 * only the process. A second backend (`codex app-server`) plugs in by exporting
 * the same two things: argv, and a normalizer that yields `AgentChatEvent`s.
 *
 * Two flags carry the whole feature and neither is obvious:
 *
 *   --include-partial-messages   token deltas as `stream_event`s; without it
 *                                text only lands when a message completes
 *   --permission-prompt-tool stdio
 *                                routes permission prompts to us as
 *                                `can_use_tool` control requests instead of
 *                                failing the tool. UNDOCUMENTED — it is absent
 *                                from `claude --help` (verified 2.1.220), so
 *                                `npm run canary` asserts it still works.
 *
 * The awkward part is that assistant text arrives by *two* routes. Model output
 * streams as `stream_event` deltas and is then repeated in a final `assistant`
 * message, while locally-handled slash commands (`/context`) skip streaming
 * entirely and only ever produce the `assistant` message. Rendering both routes
 * duplicates every reply; rendering only one loses half of them. So we remember
 * which message ids streamed (`streamedMessages`) and take text from the
 * `assistant` event only for the ones that did not.
 */

import type {
  AgentChatEvent,
  ChatSessionInfo,
  PermissionSuggestion,
  ToolCall
} from '../shared/agent-chat'

/** Argv for one chat session. `sessionId` resumes an existing conversation. */
export function claudeChatArgs(opts: {
  model?: string
  effort?: string
  permissionMode?: string
  sessionId?: string
  extraDirs?: string[]
}): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--verbose'
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  // Chewo renders the approval card, so the CLI must not pre-approve anything
  // the user would expect to be asked about. `default` keeps its own rules.
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  if (opts.sessionId) args.push('--resume', opts.sessionId)
  for (const dir of opts.extraDirs ?? []) args.push('--add-dir', dir)
  return args
}

interface RawEvent {
  type?: string
  subtype?: string
  [key: string]: unknown
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** Tool results come back as a string or as content parts; flatten to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string }
        if (p.type === 'text' && typeof p.text === 'string') return p.text
        return p.type ? `[${p.type}]` : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Stateful because block identity is per-message: the wire numbers blocks
 * `0,1,2…` inside each message, so an index alone is not unique across a turn.
 */
export function createClaudeNormalizer(): (raw: unknown) => AgentChatEvent[] {
  let messageSeq = 0
  let currentMessageId = ''
  /** block index → the id we handed the renderer, for the message in flight */
  let openBlocks = new Map<number, { blockId: string; kind: 'text' | 'thinking' | 'tool' }>()
  /** Message ids that streamed, so the trailing `assistant` echo is not re-rendered */
  const streamedMessages = new Set<string>()

  const blockId = (index: number): string => `${currentMessageId || `m${messageSeq}`}:${index}`

  return function normalize(raw: unknown): AgentChatEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const ev = raw as RawEvent
    const out: AgentChatEvent[] = []

    // ---- session bootstrap ----
    if (ev.type === 'system' && ev.subtype === 'init') {
      const info: ChatSessionInfo = {
        sessionId: String(ev.session_id ?? ''),
        model: String(ev.model ?? ''),
        cwd: String(ev.cwd ?? ''),
        slashCommands: Array.isArray(ev.slash_commands) ? (ev.slash_commands as string[]) : [],
        mcpServers: Array.isArray(ev.mcp_servers)
          ? (ev.mcp_servers as Array<{ name: string; status: string }>)
          : []
      }
      return [{ type: 'session', info }]
    }

    // ---- token streaming ----
    if (ev.type === 'stream_event') {
      const inner = ev.event as RawEvent | undefined
      if (!inner) return []

      if (inner.type === 'message_start') {
        const message = inner.message as { id?: string } | undefined
        messageSeq++
        currentMessageId = message?.id ?? `m${messageSeq}`
        openBlocks = new Map()
        streamedMessages.add(currentMessageId)
        return []
      }

      if (inner.type === 'content_block_start') {
        const index = Number(inner.index ?? 0)
        const block = inner.content_block as ContentBlock | undefined
        if (block?.type === 'thinking' || block?.type === 'text') {
          const id = blockId(index)
          openBlocks.set(index, { blockId: id, kind: block.type })
          return [{ type: 'block_start', blockId: id, block: block.type }]
        }
        if (block?.type === 'tool_use' && block.id) {
          openBlocks.set(index, { blockId: block.id, kind: 'tool' })
          const call: ToolCall = {
            toolUseId: block.id,
            name: block.name ?? 'tool',
            input: {},
            status: 'running',
            parentToolUseId: (ev.parent_tool_use_id as string | null) ?? null
          }
          return [{ type: 'tool_start', call }]
        }
        return []
      }

      if (inner.type === 'content_block_delta') {
        const open = openBlocks.get(Number(inner.index ?? 0))
        if (!open || open.kind === 'tool') return [] // input_json_delta is assembled by the CLI
        const delta = inner.delta as { type?: string; text?: string; thinking?: string } | undefined
        const text = delta?.type === 'text_delta' ? delta.text : delta?.type === 'thinking_delta' ? delta.thinking : undefined
        // signature_delta carries no user-visible text
        return text ? [{ type: 'block_delta', blockId: open.blockId, text }] : []
      }

      if (inner.type === 'content_block_stop') {
        const open = openBlocks.get(Number(inner.index ?? 0))
        if (!open || open.kind === 'tool') return []
        return [{ type: 'block_end', blockId: open.blockId }]
      }

      return []
    }

    // ---- completed assistant message ----
    if (ev.type === 'assistant') {
      const message = ev.message as { id?: string; content?: ContentBlock[] } | undefined
      const id = message?.id ?? ''
      const alreadyStreamed = streamedMessages.has(id)
      let index = 0
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use' && block.id) {
          // The chip already exists from content_block_start; this fills in the
          // arguments the model finished assembling. If nothing streamed, it is
          // also the first we hear of the call.
          if (alreadyStreamed) out.push({ type: 'tool_input', toolUseId: block.id, input: block.input ?? {} })
          else
            out.push({
              type: 'tool_start',
              call: {
                toolUseId: block.id,
                name: block.name ?? 'tool',
                input: block.input ?? {},
                status: 'running',
                parentToolUseId: (ev.parent_tool_use_id as string | null) ?? null
              }
            })
        } else if (!alreadyStreamed && (block.type === 'text' || block.type === 'thinking')) {
          // Never streamed (a locally-handled slash command) — synthesize the
          // open/append/close trio so the renderer has one code path.
          const text = block.type === 'text' ? block.text : block.thinking
          if (text) {
            const synthetic = `${id || `m${++messageSeq}`}:${index}`
            out.push({ type: 'block_start', blockId: synthetic, block: block.type })
            out.push({ type: 'block_delta', blockId: synthetic, text })
            out.push({ type: 'block_end', blockId: synthetic })
          }
        }
        index++
      }
      return out
    }

    // ---- tool results ride back as a synthetic user message ----
    if (ev.type === 'user') {
      const message = ev.message as { content?: ContentBlock[] | string } | undefined
      if (!Array.isArray(message?.content)) return []
      for (const block of message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          out.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            result: resultText(block.content),
            isError: Boolean(block.is_error)
          })
        }
      }
      return out
    }

    // ---- permission request ----
    if (ev.type === 'control_request') {
      const request = ev.request as
        | {
            subtype?: string
            tool_use_id?: string
            display_name?: string
            description?: string
            permission_suggestions?: PermissionSuggestion[]
          }
        | undefined
      if (request?.subtype !== 'can_use_tool' || !request.tool_use_id) return []
      return [
        {
          type: 'tool_approval',
          toolUseId: request.tool_use_id,
          requestId: String(ev.request_id ?? ''),
          description: request.description,
          suggestions: request.permission_suggestions ?? []
        }
      ]
    }

    // ---- turn boundary ----
    if (ev.type === 'result') {
      return [
        {
          type: 'turn_end',
          stats: {
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
            durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
            isError: Boolean(ev.is_error)
          }
        }
      ]
    }

    if (ev.type === 'error' && typeof ev.message === 'string')
      return [{ type: 'notice', tone: 'error', text: ev.message }]

    return []
  }
}
