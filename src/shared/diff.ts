/**
 * The patch a file-editing tool actually applied, and the parser that recovers
 * it.
 *
 * An Edit's textual result is only "The file … has been updated successfully",
 * so a UI built on that can name the file and nothing else — not a line, not a
 * character. The real diff rides alongside it: `tool_use_result` on the live
 * stream, `toolUseResult` in the session file on disk, **the same value shape
 * both ways** (verified against CLI 2.1.220, 2026-08-03), which is why one
 * parser serves `claude-chat.ts` and `adapter/claude.ts` both.
 *
 * Shapes seen from the CLI:
 *   Edit / MultiEdit  { filePath, oldString, newString, structuredPatch: [hunk…] }
 *   Write (new file)  { type: 'create', filePath, content, structuredPatch: [] }
 *   Read              { type: 'text', file: {…} }            → no patch
 *
 * A created file reports an *empty* patch — there is no "before" to diff
 * against — so its body is turned into an all-added hunk here rather than
 * rendering as "edited, no changes".
 *
 * Renderer-safe: no node imports in this file.
 */

/** One hunk of a unified diff, in the CLI's own shape. */
export interface DiffHunk {
  /** 1-based first line in the file as it was; 0 when the file did not exist */
  oldStart: number
  oldLines: number
  /** 1-based first line in the file as it is now */
  newStart: number
  newLines: number
  /** Unified-diff rows, each prefixed with a space, '-' or '+' */
  lines: string[]
}

export interface ToolPatch {
  filePath: string
  hunks: DiffHunk[]
  /** The file did not exist before, so every row is an addition */
  created?: boolean
  /** Rows dropped by the cap — reported rather than silently swallowed */
  omitted?: number
}

/**
 * Whole-file writes are unbounded, and every row crosses an IPC boundary and
 * then becomes a DOM node. A cap keeps one `Write` of a 5,000-line file from
 * costing more than the conversation around it.
 */
const PATCH_LINE_CAP = 500

function isHunk(value: unknown): value is DiffHunk {
  if (!value || typeof value !== 'object') return false
  const h = value as Record<string, unknown>
  return (
    typeof h.oldStart === 'number' &&
    typeof h.newStart === 'number' &&
    Array.isArray(h.lines) &&
    h.lines.every((l) => typeof l === 'string')
  )
}

/** Split a written file body into diff rows. A trailing newline is a line
 *  terminator, not an empty last line. */
function createdHunk(content: string): DiffHunk {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body.length ? body.split('\n') : []
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((l) => `+${l}`)
  }
}

/** Trim to `PATCH_LINE_CAP` rows total, reporting how many were dropped. */
function capped(hunks: DiffHunk[]): { hunks: DiffHunk[]; omitted: number } {
  let budget = PATCH_LINE_CAP
  let omitted = 0
  const out: DiffHunk[] = []
  for (const hunk of hunks) {
    if (budget <= 0) {
      omitted += hunk.lines.length
      continue
    }
    if (hunk.lines.length <= budget) {
      out.push(hunk)
      budget -= hunk.lines.length
      continue
    }
    out.push({ ...hunk, lines: hunk.lines.slice(0, budget) })
    omitted += hunk.lines.length - budget
    budget = 0
  }
  return { hunks: out, omitted }
}

/**
 * The `tool_use_result` / `toolUseResult` payload → a patch, or `undefined` for
 * every tool that did not touch a file. Never throws: an unknown shape is a
 * tool we do not render a diff for, not an error.
 */
export function parseToolPatch(raw: unknown): ToolPatch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { filePath?: unknown; structuredPatch?: unknown; content?: unknown; type?: unknown }
  if (typeof r.filePath !== 'string' || !r.filePath) return undefined

  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch.filter(isHunk) : []
  if (hunks.length) {
    const { hunks: kept, omitted } = capped(hunks)
    return { filePath: r.filePath, hunks: kept, ...(omitted ? { omitted } : {}) }
  }

  if (r.type === 'create' && typeof r.content === 'string') {
    const { hunks: kept, omitted } = capped([createdHunk(r.content)])
    return { filePath: r.filePath, created: true, hunks: kept, ...(omitted ? { omitted } : {}) }
  }

  return undefined
}

/**
 * A patch → unified diff text, which is what `DiffBody` renders.
 *
 * The `@@` headers are not decoration: they are what carries the line numbers
 * through, since the renderer counts rows forward from each header. Serializing
 * back to text rather than rendering hunks directly is what lets a tool's diff
 * and a git diff go through one renderer.
 *
 * `maxRows` folds long diffs — `hidden` counts everything not in the text,
 * including whatever the parser already capped away, so a caller can say how
 * much is missing without knowing which stage dropped it.
 */
export function patchToUnified(
  patch: ToolPatch,
  maxRows = Infinity
): { text: string; hidden: number } {
  const out: string[] = []
  let budget = maxRows
  let hidden = patch.omitted ?? 0
  for (const hunk of patch.hunks) {
    if (budget <= 0) {
      hidden += hunk.lines.length
      continue
    }
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    const rows = hunk.lines.slice(0, budget)
    hidden += hunk.lines.length - rows.length
    budget -= rows.length
    out.push(...rows)
  }
  return { text: out.join('\n'), hidden }
}

/** Added/removed row counts, for the `+12 −3` badge on a tool chip. */
export function patchStats(patch: ToolPatch): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}
