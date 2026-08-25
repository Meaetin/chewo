import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { promptTokens } from '../agent-chat'
import { parseToolPatch, type ToolPatch } from '../diff'
import { splitToolResult, type ToolImage } from '../tool-images'
import { applyTaskResult, parseTaskResult, type AgentTask } from '../tool-tasks'
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
  message?: { role?: string; content?: unknown; usage?: unknown; model?: string }
  /** The reasoning effort that turn ran at — a sibling of `message`, not a
   *  field inside it. Written on every assistant record (2.1.240). */
  effort?: string
  /** The tool's own structured payload, which is where an Edit's real diff
   *  lives — the `tool_result` block beside it only carries prose */
  toolUseResult?: unknown
}

/** What a `tool_use_id` came back with: prose for every tool, plus the patch
 *  for the ones that edited a file and the pictures for the ones that read an
 *  image. */
interface ToolOutcome {
  text: string
  patch?: ToolPatch
  images?: ToolImage[]
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

/**
 * Total base64 a resumed conversation will carry. A session file keeps every
 * screenshot it ever read and a resumed pane holds every item in memory, so the
 * budget is spent **newest-first** — `collectToolResults` walks records
 * backwards — and anything past it degrades to its "not shown" line rather than
 * to silence.
 */
const SEED_IMAGE_BUDGET = 24_000_000

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

function recordToMessages(rec: ClaudeRecord, results: Map<string, ToolOutcome>): NormalizedMessage[] {
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
      const outcome = block.id ? results.get(block.id) : undefined
      out.push({
        role: 'tool',
        toolName: block.name ?? 'unknown',
        text: summarizeToolInput(block.input),
        // The arguments themselves, not just the one-line gist of them. A
        // resumed pane names a call from its own `description` and shows what a
        // subagent was briefed with; without this it can only re-read the gist,
        // which is the command with everything that explains it thrown away.
        toolInput: block.input,
        filesTouched: extractFiles(block.input),
        toolResult: outcome?.text || undefined,
        toolPatch: outcome?.patch,
        toolImages: outcome?.images,
        ...base
      })
    }
    // tool_result blocks surface via the results map; thinking blocks are dropped
  }
  return out
}

/**
 * The plan as it stood when the conversation was last written.
 *
 * Folded forward rather than read off the newest `TaskList`, because a plan is
 * usually built with `TaskCreate`/`TaskUpdate` and listed rarely or never — a
 * snapshot-only read would leave most resumed panes with no plan at all. A
 * `tool_use` always precedes its result in the file, so one forward pass can
 * both collect the inputs and apply the results that need them.
 */
function collectTasks(records: ClaudeRecord[]): AgentTask[] {
  const inputs = new Map<string, unknown>()
  let tasks: AgentTask[] = []

  for (const rec of records) {
    if (!Array.isArray(rec.message?.content)) continue
    const blocks = rec.message.content as ContentBlock[]

    if (rec.type === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use' && b.id) inputs.set(b.id, b.input)
      continue
    }
    if (rec.type !== 'user') continue

    // Same one-result rule as the patch above: `toolUseResult` is per record,
    // so a record with two results cannot say which call this one describes.
    const results = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id)
    if (results.length !== 1) continue
    const parsed = parseTaskResult(rec.toolUseResult)
    if (parsed) tasks = applyTaskResult(tasks, parsed, inputs.get(results[0].tool_use_id as string))
  }

  return tasks
}

/**
 * Map tool_use_id → what the call produced, across the whole file.
 *
 * `toolUseResult` sits on the *record*, not inside the content array, so a
 * record carrying more than one tool_result cannot say which patch belongs to
 * which — the CLI writes one per record in practice, and claiming otherwise
 * would attach a diff to the wrong file.
 */
function collectToolResults(records: ClaudeRecord[]): Map<string, ToolOutcome> {
  const results = new Map<string, ToolOutcome>()
  let spent = 0
  // Backwards, so the images the budget buys are the ones nearest the bottom of
  // the conversation — where a resumed pane opens. Ids are unique, so walking
  // the other way changes nothing else.
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec.type !== 'user' || !Array.isArray(rec.message?.content)) continue
    const blocks = (rec.message.content as ContentBlock[]).filter(
      (b) => b.type === 'tool_result' && b.tool_use_id
    )
    const patch = blocks.length === 1 ? parseToolPatch(rec.toolUseResult) : undefined
    for (const block of blocks) {
      const { text, images } = splitToolResult(block.content, { textCap: RESULT_CAP })
      const kept: ToolImage[] = []
      const dropped: string[] = []
      for (const image of images) {
        if (spent + image.data.length > SEED_IMAGE_BUDGET) dropped.push('[image — not shown]')
        else {
          spent += image.data.length
          kept.push(image)
        }
      }
      const prose = [text, ...dropped].filter(Boolean).join('\n')
      if (prose || patch || kept.length) {
        results.set(block.tool_use_id as string, {
          text: prose,
          patch,
          ...(kept.length ? { images: kept } : {})
        })
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

  // Emptiness gate (scan.ts) counts across the whole main timeline, not the
  // linearized `chain` above. Mid-turn the chain can momentarily hold 0
  // countable messages — a compaction/summary boundary breaks the parentUuid
  // walk — which would drop a live, actively-writing session out of the
  // sidebar until the next scan. Records are only ever appended, so this count
  // never dips back to 0 once a session has real content.
  const mainMessages: NormalizedMessage[] = mainRecs.flatMap((r) => recordToMessages(r, toolResults))

  /**
   * The parentUuid walk is only trustworthy when it actually reaches the first
   * record. Compaction and summary boundaries re-point or drop parentUuid, and
   * every boundary severs the chain — measured on a real long session, 964
   * main records yielded a 16-record chain across 58 breaks, so the transcript
   * showed the last handful of messages and nothing else.
   *
   * When the walk is short, fall back to append order. That gives up pruning
   * abandoned rewind branches, but only in the case where the links are too
   * broken to prune by — and showing a few superseded messages beats showing
   * 2% of the conversation.
   */
  const chainReachesStart = chain.length > 0 && chain[0] === mainRecs[0]
  const messages: NormalizedMessage[] = chainReachesStart
    ? chain.flatMap((r) => recordToMessages(r, toolResults))
    : [...mainMessages]
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

  // Read from `mainRecs`, not from `chain`: the linearized chain can be a
  // fraction of the file when compaction broke the parentUuid walk, and the
  // newest record is the one that knows the current size either way. A
  // sidechain record reports a subagent's context, not this conversation's.
  const contextTokens = (() => {
    for (let i = mainRecs.length - 1; i >= 0; i--) {
      if (mainRecs[i].type !== 'assistant') continue
      const tokens = promptTokens(mainRecs[i].message?.usage)
      if (tokens) return tokens
    }
    return undefined
  })()

  // What the conversation was last running on. Same walk and the same reason
  // as `contextTokens` above: `--resume` replays nothing, so without this a
  // resumed pane cannot say which model or effort it is about to speak on —
  // and it is not told until a whole turn has gone by.
  const settings = (() => {
    for (let i = mainRecs.length - 1; i >= 0; i--) {
      const record = mainRecs[i]
      if (record.type !== 'assistant') continue
      const model = record.message?.model
      if (model) return { model, effort: record.effort }
    }
    return {}
  })()

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
    contextTokens,
    ...settings,
    // Read from every record, not just the linearized chain: a plan built
    // before a compaction boundary is still the plan.
    tasks: collectTasks(mainRecs),
    messages,
    stats
  }
}
