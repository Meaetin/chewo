import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { extractCommand, isInjectedNoise, untitledFallback } from './noise'
import type { NormalizedMessage, ParseResult, ParseStats } from './types'

/**
 * Parser for Codex CLI rollout files:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Format notes (observed on codex-cli 0.142.x — undocumented, may drift):
 * - Line types: `session_meta` (cwd, model, cli_version), `response_item`
 *   (OpenAI Responses API items — the actual conversation), `event_msg`
 *   (lifecycle events; duplicates message text, so ignored for messages).
 * - Titles live externally in ~/.codex/session_index.jsonl, passed in as
 *   `titleIndex`.
 */

interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    cwd?: string
    role?: string
    content?: Array<{ type?: string; text?: string }>
    name?: string
    arguments?: string
    input?: string
    action?: { command?: string[] }
    call_id?: string
    /** `turn_context` only: what that turn ran on */
    model?: string
    effort?: string
    output?: unknown
  }
}

const RESULT_CAP = 4000

/** Tool outputs range from raw strings to JSON wrappers and typed content arrays. */
function outputValue(output: unknown): string {
  if (typeof output === 'string') {
    try {
      return outputValue(JSON.parse(output))
    } catch {
      return output
    }
  }
  if (Array.isArray(output)) return output.map(outputValue).filter(Boolean).join('\n')
  if (!output || typeof output !== 'object') return output == null ? '' : String(output)
  const value = output as Record<string, unknown>
  if (value.output !== undefined) return outputValue(value.output)
  if (typeof value.text === 'string') return value.text
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function outputText(output: unknown): string {
  return outputValue(output).slice(0, RESULT_CAP)
}

/** Recover the outer patch string without mistaking patch-looking fixture text inside it. */
function patchText(source: string): string {
  const literal = /\b(?:const|let|var)\s+patch\s*=\s*("(?:\\.|[^"\\])*")/.exec(source)?.[1]
  if (!literal) return source
  try {
    return JSON.parse(literal) as string
  } catch {
    return source
  }
}

const KNOWN_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'])

/** Extract the session UUID from `rollout-2026-06-05T16-15-28-<uuid>.jsonl` */
function idFromFilename(filePath: string): string {
  const name = basename(filePath, '.jsonl')
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return m?.[0] ?? name
}

function responseItemToMessage(
  payload: NonNullable<CodexRecord['payload']>,
  timestamp: string | undefined,
  results: Map<string, string>
): NormalizedMessage | null {
  if (payload.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : 'user'
    const text = (payload.content ?? [])
      .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
      .map((c) => c.text)
      .join('\n')
    if (!text.trim()) return null
    if (role === 'user') {
      const command = extractCommand(text)
      if (command) return { role, text: command, commandName: command, timestamp }
      if (isInjectedNoise(text)) return null
    }
    return { role, text, timestamp }
  }
  if (payload.type === 'function_call') {
    let text = payload.arguments ?? ''
    try {
      const args = JSON.parse(payload.arguments ?? '{}')
      if (Array.isArray(args.command)) text = args.command.join(' ')
      else if (typeof args.command === 'string') text = args.command
    } catch {
      /* keep raw arguments string */
    }
    return {
      role: 'tool',
      toolName: payload.name ?? 'unknown',
      text: text.slice(0, 300),
      toolResult: payload.call_id ? results.get(payload.call_id) : undefined,
      timestamp
    }
  }
  if (payload.type === 'local_shell_call') {
    const callId = payload.call_id ?? payload.id
    return {
      role: 'tool',
      toolName: 'shell',
      text: (payload.action?.command ?? []).join(' ').slice(0, 300),
      toolResult: callId ? results.get(callId) : undefined,
      timestamp
    }
  }
  if (payload.type === 'custom_tool_call') {
    const source = payload.input ?? ''
    const nested = [...source.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1])
    const operation = nested[0] ?? payload.name ?? 'tool'
    const filesTouched = [
      ...patchText(source).matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)
    ]
      .map((m) => m[1].trim())
      .filter(Boolean)

    if (operation === 'apply_patch' || filesTouched.length) {
      const input = filesTouched.length
        ? { path: filesTouched[0], ...(filesTouched.length > 1 ? { paths: filesTouched } : {}) }
        : {}
      return {
        role: 'tool',
        toolName: 'apply_patch',
        toolDisplayName: 'Edit',
        text: filesTouched[0] ?? 'Patch',
        toolInput: input,
        filesTouched,
        toolResult: payload.call_id ? results.get(payload.call_id) : undefined,
        timestamp
      }
    }

    if (operation === 'exec_command') {
      const rawCommand = /\bcmd\s*:\s*("(?:\\.|[^"\\])*")/.exec(source)?.[1]
      let command = 'Command'
      if (rawCommand) {
        try {
          command = JSON.parse(rawCommand) as string
        } catch {
          command = rawCommand.slice(1, -1)
        }
      }
      return {
        role: 'tool',
        toolName: 'shell',
        toolDisplayName: 'Shell',
        text: command,
        toolInput: { command },
        toolResult: payload.call_id ? results.get(payload.call_id) : undefined,
        timestamp
      }
    }

    const displayName: Record<string, string> = {
      view_image: 'View image',
      web__run: 'Web',
      update_plan: 'Plan',
      read_mcp_resource: 'Read resource'
    }
    return {
      role: 'tool',
      toolName: operation,
      toolDisplayName: displayName[operation],
      text: source.slice(0, 300),
      toolInput: source ? { command: source.slice(0, 300) } : {},
      toolResult: payload.call_id ? results.get(payload.call_id) : undefined,
      timestamp
    }
  }
  // reasoning / tool output / web_search_call etc. — outputs are folded into calls
  return null
}

export function parseCodexSession(
  filePath: string,
  opts: { titleIndex?: Map<string, string> } = {}
): ParseResult {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())

  const stats: ParseStats = { linesTotal: lines.length, linesUnparseable: 0, unknownTypes: {} }
  const records: CodexRecord[] = []

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as CodexRecord
      records.push(rec)
      if (rec.type && !KNOWN_TYPES.has(rec.type)) {
        stats.unknownTypes[rec.type] = (stats.unknownTypes[rec.type] ?? 0) + 1
      }
    } catch {
      stats.linesUnparseable++
    }
  }

  const sessionMeta = records.find((r) => r.type === 'session_meta')?.payload
  const id = sessionMeta?.id ?? idFromFilename(filePath)

  // Codex writes a `turn_context` before each turn naming the model and the
  // reasoning effort it ran at, so the newest one is what a resumed thread
  // continues on. `session_meta` is deliberately not used for this: a thread
  // can be moved onto another model mid-conversation, which leaves the opening
  // record describing a model the session is no longer using.
  const lastTurn = [...records].reverse().find((r) => r.type === 'turn_context')?.payload

  // First pass: collect tool outputs so calls can carry their results
  const toolResults = new Map<string, string>()
  for (const rec of records) {
    const p = rec.payload
    if (rec.type !== 'response_item' || !p) continue
    if (
      (p.type === 'function_call_output' ||
        p.type === 'local_shell_call_output' ||
        p.type === 'custom_tool_call_output') &&
      p.call_id
    ) {
      const text = outputText(p.output)
      if (text) toolResults.set(p.call_id, text)
    }
  }

  const messages: NormalizedMessage[] = []
  for (const rec of records) {
    if (rec.type !== 'response_item' || !rec.payload) continue
    const msg = responseItemToMessage(rec.payload, rec.timestamp, toolResults)
    if (msg) messages.push(msg)
  }

  const firstUserText = messages.find((m) => m.role === 'user' && !m.commandName)?.text ?? ''
  const preview = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 120)
  const firstAssistantText =
    messages.find((m) => m.role === 'assistant')?.text.replace(/\s+/g, ' ').trim().slice(0, 50) ?? ''

  const timestamps = records.map((r) => r.timestamp).filter((t): t is string => !!t)

  // Codex's own session_index can store junk thread_names (command XML) —
  // trust it only when it doesn't look machine-generated
  const indexTitle = opts.titleIndex?.get(id)
  const cleanIndexTitle = indexTitle && !isInjectedNoise(indexTitle) ? indexTitle : undefined

  return {
    meta: {
      id,
      source: 'codex',
      title:
        cleanIndexTitle ?? (preview || firstAssistantText || untitledFallback(timestamps[0] ?? '')),
      project: sessionMeta?.cwd ?? null,
      createdAt: timestamps[0] ?? '',
      updatedAt: timestamps[timestamps.length - 1] ?? '',
      filePath,
      messageCount: messages.filter((m) => !m.commandName).length,
      preview
    },
    ...(lastTurn?.model ? { model: lastTurn.model } : {}),
    ...(lastTurn?.effort ? { effort: lastTurn.effort } : {}),
    messages,
    stats
  }
}

/** Parse ~/.codex/session_index.jsonl into an id → thread_name map. */
export function parseCodexTitleIndex(indexPath: string): Map<string, string> {
  const map = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(indexPath, 'utf8')
  } catch {
    return map
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as { id?: string; thread_name?: string }
      if (rec.id && rec.thread_name) map.set(rec.id, rec.thread_name)
    } catch {
      /* skip */
    }
  }
  return map
}
