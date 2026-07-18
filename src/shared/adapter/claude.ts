import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { extractCommand, isInjectedNoise, untitledFallback } from './noise'
import type { NormalizedMessage, ParseResult, ParseStats } from './types'

/**
 * Parser for Claude Code session files:
 *   ~/.claude/projects/<dashed-cwd>/<sessionId>.jsonl
 *
 * Format notes (observed on Claude Code 2.1.x — undocumented, may drift):
 * - One JSON record per line, discriminated by `type`.
 * - `user` / `assistant` records carry the raw Anthropic API message under
 *   `message`, plus `uuid` / `parentUuid` forming a tree. `isSidechain: true`
 *   marks subagent branches.
 * - Title lives in an `ai-title` record (newer), a `summary` record (older),
 *   or the `slug` field on message records.
 * - Unknown line types are counted and skipped, never fatal.
 */

interface ClaudeRecord {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  gitBranch?: string
  slug?: string
  sessionId?: string
  aiTitle?: string
  customTitle?: string
  agentName?: string
  summary?: string
  message?: { role?: string; content?: unknown }
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  tool_use_id?: string
  content?: unknown
  input?: Record<string, unknown>
}

const RESULT_CAP = 4000

/** tool_result content is a string or an array of text blocks */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, RESULT_CAP)
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .slice(0, RESULT_CAP)
  }
  return ''
}

const KNOWN_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'bridge-session',
  'last-prompt',
  'ai-title',
  'custom-title',
  'agent-name',
  'summary',
  'progress',
  'queue-operation',
  'file-history-delta',
  'pr-link'
])

function extractFiles(input: Record<string, unknown> | undefined): string[] {
  if (!input) return []
  const files: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key]
    if (typeof v === 'string') files.push(v)
  }
  return files
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  const files = extractFiles(input)
  if (files.length) return files.join(', ')
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return ''
  }
}

function recordToMessages(rec: ClaudeRecord, results: Map<string, string>): NormalizedMessage[] {
  const msg = rec.message
  if (!msg) return []
  const role = rec.type === 'assistant' ? 'assistant' : 'user'
  const out: NormalizedMessage[] = []
  const base = { timestamp: rec.timestamp, isSidechain: rec.isSidechain || undefined }

  // Slash commands → compact chip; other injected pseudo-XML → dropped.
  // Assistant text passes through untouched.
  const pushText = (text: string): void => {
    if (!text.trim()) return
    if (role === 'user') {
      const command = extractCommand(text)
      if (command) {
        out.push({ role, text: command, commandName: command, ...base })
        return
      }
      if (isInjectedNoise(text)) return
    }
    out.push({ role, text, ...base })
  }

  if (typeof msg.content === 'string') {
    pushText(msg.content)
    return out
  }
  if (!Array.isArray(msg.content)) return out

  for (const block of msg.content as ContentBlock[]) {
    if (block.type === 'text' && block.text?.trim()) {
      pushText(block.text)
    } else if (block.type === 'tool_use') {
      out.push({
        role: 'tool',
        toolName: block.name ?? 'unknown',
        text: summarizeToolInput(block.input),
        filesTouched: extractFiles(block.input),
        toolResult: block.id ? results.get(block.id) : undefined,
        ...base
      })
    }
    // tool_result blocks surface via the results map; thinking blocks are dropped
  }
  return out
}

/** Map tool_use_id → result text across the whole file. */
function collectToolResults(records: ClaudeRecord[]): Map<string, string> {
  const results = new Map<string, string>()
  for (const rec of records) {
    if (rec.type !== 'user' || !Array.isArray(rec.message?.content)) continue
    for (const block of rec.message.content as ContentBlock[]) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const text = resultText(block.content)
        if (text) results.set(block.tool_use_id, text)
      }
    }
  }
  return results
}

export function parseClaudeSession(
  filePath: string,
  opts: { includeSidechains?: boolean } = {}
): ParseResult {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())

  const stats: ParseStats = { linesTotal: lines.length, linesUnparseable: 0, unknownTypes: {} }
  const records: ClaudeRecord[] = []

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as ClaudeRecord
      records.push(rec)
      if (rec.type && !KNOWN_TYPES.has(rec.type)) {
        stats.unknownTypes[rec.type] = (stats.unknownTypes[rec.type] ?? 0) + 1
      }
    } catch {
      stats.linesUnparseable++
    }
  }

  const msgRecs = records.filter(
    (r) => (r.type === 'user' || r.type === 'assistant') && r.message
  )
  const byUuid = new Map<string, ClaudeRecord>()
  for (const r of msgRecs) if (r.uuid) byUuid.set(r.uuid, r)

  // Linearize: walk parentUuid chain up from the newest non-sidechain record.
  // This follows the *active* branch after rewinds/forks and drops abandoned ones.
  const mainRecs = msgRecs.filter((r) => !r.isSidechain)
  const leaf = mainRecs[mainRecs.length - 1]
  const chain: ClaudeRecord[] = []
  const seen = new Set<string>()
  let cursor: ClaudeRecord | undefined = leaf
  while (cursor) {
    if (cursor.uuid) {
      if (seen.has(cursor.uuid)) break // cycle guard
      seen.add(cursor.uuid)
    }
    chain.unshift(cursor)
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined
  }

  const toolResults = collectToolResults(records)
  const messages: NormalizedMessage[] = chain.flatMap((r) => recordToMessages(r, toolResults))

  // Emptiness gate (scan.ts) counts across the whole main timeline, not the
  // linearized `chain` above. Mid-turn the chain can momentarily hold 0
  // countable messages — a compaction/summary boundary breaks the parentUuid
  // walk — which would drop a live, actively-writing session out of the
  // sidebar until the next scan. Records are only ever appended, so this count
  // never dips back to 0 once a session has real content.
  const mainMessages: NormalizedMessage[] = mainRecs.flatMap((r) => recordToMessages(r, toolResults))
  if (opts.includeSidechains) {
    messages.push(
      ...msgRecs.filter((r) => r.isSidechain).flatMap((r) => recordToMessages(r, toolResults))
    )
  }

  // --- meta ---
  const first = (pick: (r: ClaudeRecord) => string | undefined): string | undefined => {
    for (const r of records) {
      const v = pick(r)
      if (v) return v
    }
    return undefined
  }

  const firstUserText = messages.find((m) => m.role === 'user' && !m.commandName)?.text ?? ''
  const preview = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 120)
  const firstAssistantText =
    messages.find((m) => m.role === 'assistant')?.text.replace(/\s+/g, ' ').trim().slice(0, 50) ?? ''
  const created = records.find((r) => r.timestamp)?.timestamp ?? ''

  // custom-title is a user-set rename — it outranks the generated ai-title.
  // Final fallbacks never surface a raw UUID.
  const title =
    first((r) => (r.type === 'custom-title' ? r.customTitle : undefined)) ??
    first((r) => (r.type === 'ai-title' ? r.aiTitle : undefined)) ??
    first((r) => (r.type === 'summary' ? r.summary : undefined)) ??
    first((r) => (r.type === 'agent-name' ? r.agentName : undefined))?.replace(/-/g, ' ') ??
    first((r) => r.slug)?.replace(/-/g, ' ') ??
    (preview || firstAssistantText || untitledFallback(created))

  const timestamps = records.map((r) => r.timestamp).filter((t): t is string => !!t)

  return {
    meta: {
      id: first((r) => r.sessionId) ?? basename(filePath, '.jsonl'),
      source: 'claude',
      title,
      project: first((r) => r.cwd) ?? null,
      gitBranch: first((r) => r.gitBranch),
      createdAt: timestamps[0] ?? '',
      updatedAt: timestamps[timestamps.length - 1] ?? '',
      filePath,
      messageCount: mainMessages.filter((m) => !m.commandName).length,
      preview
    },
    messages,
    stats
  }
}
