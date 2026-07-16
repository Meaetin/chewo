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
    action?: { command?: string[] }
  }
}

const KNOWN_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'])

/** Extract the session UUID from `rollout-2026-06-05T16-15-28-<uuid>.jsonl` */
function idFromFilename(filePath: string): string {
  const name = basename(filePath, '.jsonl')
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return m?.[0] ?? name
}

function responseItemToMessage(payload: NonNullable<CodexRecord['payload']>, timestamp?: string): NormalizedMessage | null {
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
    return { role: 'tool', toolName: payload.name ?? 'unknown', text: text.slice(0, 300), timestamp }
  }
  if (payload.type === 'local_shell_call') {
    return {
      role: 'tool',
      toolName: 'shell',
      text: (payload.action?.command ?? []).join(' ').slice(0, 300),
      timestamp
    }
  }
  // reasoning / function_call_output / web_search_call etc. — dropped in v1
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

  const messages: NormalizedMessage[] = []
  for (const rec of records) {
    if (rec.type !== 'response_item' || !rec.payload) continue
    const msg = responseItemToMessage(rec.payload, rec.timestamp)
    if (msg) messages.push(msg)
  }

  const firstUserText = messages.find((m) => m.role === 'user' && !m.commandName)?.text ?? ''
  const preview = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 120)
  const firstAssistantText =
    messages.find((m) => m.role === 'assistant')?.text.replace(/\s+/g, ' ').trim().slice(0, 50) ?? ''

  const timestamps = records.map((r) => r.timestamp).filter((t): t is string => !!t)

  return {
    meta: {
      id,
      source: 'codex',
      title:
        opts.titleIndex?.get(id) ??
        (preview || firstAssistantText || untitledFallback(timestamps[0] ?? '')),
      project: sessionMeta?.cwd ?? null,
      createdAt: timestamps[0] ?? '',
      updatedAt: timestamps[timestamps.length - 1] ?? '',
      filePath,
      messageCount: messages.filter((m) => !m.commandName).length,
      preview
    },
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
