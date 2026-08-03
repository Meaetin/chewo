/**
 * The unified-diff renderer, shared by everything that shows a change: the git
 * panel's diff layer and the chat thread's edit chips. Both speak unified diff
 * text — git produces it directly, and a chat tool's `structuredPatch` is
 * serialized into it by `patchToUnified` — so there is one parser, one set of
 * line-number rules and one colour vocabulary rather than a second diff view
 * that drifts from this one.
 */

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  /** Display line number — new side, old side for deletions */
  no: number | null
  text: string
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
/** Beyond this the DOM cost hurts — the tail is cut with a notice */
const MAX_RENDER_LINES = 5000

export function parseDiff(text: string): { lines: DiffLine[]; binary: boolean } {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let binary = false
  for (const raw of text.split('\n')) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ type: 'hunk', no: null, text: raw })
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ type: 'add', no: newNo++, text: raw.slice(1) })
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      lines.push({ type: 'del', no: oldNo++, text: raw.slice(1) })
    } else if (raw.startsWith(' ')) {
      oldNo++
      lines.push({ type: 'ctx', no: newNo++, text: raw.slice(1) })
    } else if (raw.startsWith('\\')) {
      lines.push({ type: 'note', no: null, text: raw.slice(2) })
    } else if (raw.startsWith('Binary files ')) {
      binary = true
    }
    if (lines.length > MAX_RENDER_LINES) {
      lines.push({ type: 'note', no: null, text: '… diff truncated for display' })
      break
    }
  }
  return { lines, binary }
}

export function DiffBody({
  text,
  truncated
}: {
  text: string
  truncated: boolean
}): React.JSX.Element {
  const { lines, binary } = parseDiff(text)
  if (binary) return <div className="diff-notice">Binary file — no text diff</div>
  if (lines.length === 0) return <div className="diff-notice">No changes</div>
  return (
    <>
      {lines.map((l, i) =>
        l.type === 'hunk' ? (
          <div key={i} className="diff-hunk">
            {l.text}
          </div>
        ) : l.type === 'note' ? (
          <div key={i} className="diff-note">
            {l.text}
          </div>
        ) : (
          <div key={i} className={`diff-line diff-line-${l.type}`}>
            <span className="diff-ln">{l.no}</span>
            <span className="diff-code">{l.text || ' '}</span>
          </div>
        )
      )}
      {truncated && <div className="diff-note">… diff truncated (too large)</div>}
    </>
  )
}
