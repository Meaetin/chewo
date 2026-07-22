import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ChangedFile, CommitDetailResult, GitDiffSpec } from '../../../main/git'
import { FileStat, StatusLetter, timeAgo, type GitSelection } from './GitPanel'
import { IconButton } from './ui'

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

function DiffBody({ text, truncated }: { text: string; truncated: boolean }): React.JSX.Element {
  const { lines, binary } = parseDiff(text)
  if (binary) return <div className="git-diff-notice">Binary file — no text diff</div>
  if (lines.length === 0) return <div className="git-diff-notice">No changes</div>
  return (
    <>
      {lines.map((l, i) =>
        l.type === 'hunk' ? (
          <div key={i} className="git-diff-hunk">
            {l.text}
          </div>
        ) : l.type === 'note' ? (
          <div key={i} className="git-diff-note">
            {l.text}
          </div>
        ) : (
          <div key={i} className={`git-diff-line git-diff-line-${l.type}`}>
            <span className="git-diff-ln">{l.no}</span>
            <span className="git-diff-code">{l.text || ' '}</span>
          </div>
        )
      )}
      {truncated && <div className="git-diff-note">… diff truncated (too large)</div>}
    </>
  )
}

const LIST_LINE_RE = /^\s*([-*+•]|\d+[.)])\s/
const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z-]*: \S/

/**
 * Git bodies arrive hard-wrapped at ~72 columns; joining lines inside each
 * paragraph lets the text fill the pane. Paragraph breaks and list items
 * keep their line structure. A trailing trailer block (Co-Authored-By: …,
 * Signed-off-by: …) is metadata, not prose — dropped from display.
 */
export function unwrapCommitBody(body: string): string {
  const paras = body.split(/\n{2,}/)
  const last = paras[paras.length - 1]
  if (paras.length > 1 && last.split('\n').every((l) => TRAILER_LINE_RE.test(l))) paras.pop()
  return paras
    .map((para) => {
      const lines = para.split('\n')
      if (lines.some((l) => LIST_LINE_RE.test(l))) return para
      return lines.map((l) => l.trim()).join(' ')
    })
    .join('\n\n')
}

function sumStat(
  files: Array<{ additions: number | null; deletions: number | null }>,
  key: 'additions' | 'deletions'
): number | null {
  return files.reduce<number | null>((acc, f) => (f[key] === null ? acc : (acc ?? 0) + f[key]), null)
}

interface GitDiffViewProps {
  visible: boolean
  root: string
  target: GitSelection | null
  onClose: () => void
}

interface LoadedDiff {
  text: string
  truncated: boolean
  error?: string
}

/**
 * Read-only diff layer — covers the terminal inside .main-content exactly like
 * FileEditor, and Esc dismisses it the same way. Shows one working-tree file's
 * diff, or a commit: header + file list + per-file diff.
 */
export function GitDiffView({
  visible,
  root,
  target,
  onClose
}: GitDiffViewProps): React.JSX.Element {
  const [diff, setDiff] = useState<LoadedDiff | null>(null)
  const [detail, setDetail] = useState<CommitDetailResult | null>(null)
  /** Selected file inside a commit — index into detail.files */
  const [commitFileIdx, setCommitFileIdx] = useState(0)

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, onClose])

  // Commit targets load their file list first; the per-file diff follows below
  useEffect(() => {
    setDetail(null)
    setCommitFileIdx(0)
    if (!target || target.kind !== 'commit') return
    let cancelled = false
    void window.api.gitShow({ root, hash: target.hash }).then((res) => {
      if (!cancelled) setDetail(res)
    })
    return () => {
      cancelled = true
    }
  }, [root, target])

  const commitFiles = detail?.ok ? detail.files : []
  const commitFile = commitFiles[commitFileIdx]

  useEffect(() => {
    setDiff(null)
    if (!target) return
    let spec: GitDiffSpec
    if (target.kind === 'file') {
      spec = {
        kind: 'worktree',
        path: target.file.path,
        ...(target.file.origPath !== undefined && { origPath: target.file.origPath }),
        untracked: target.file.status === '?'
      }
    } else {
      if (!commitFile) return
      spec = {
        kind: 'commit',
        hash: target.hash,
        path: commitFile.path,
        ...(commitFile.origPath !== undefined && { origPath: commitFile.origPath })
      }
    }
    let cancelled = false
    void window.api.gitDiff({ root, spec }).then((res) => {
      if (cancelled) return
      setDiff(res.ok ? { text: res.text, truncated: res.truncated } : { text: '', truncated: false, error: res.error })
    })
    return () => {
      cancelled = true
    }
  }, [root, target, commitFile])

  const file: ChangedFile | null = target?.kind === 'file' ? target.file : null

  return (
    <div className="git-diff-view" style={{ display: visible ? 'flex' : 'none' }}>
      {file && (
        <div className="git-diff-header">
          <StatusLetter status={file.status} />
          <span className="git-diff-file" title={file.path}>
            {file.origPath && <span className="git-diff-orig">{file.origPath} → </span>}
            {file.path}
          </span>
          <FileStat additions={file.additions} deletions={file.deletions} />
          <span className="git-diff-esc">esc to close</span>
          <IconButton label="Close diff (esc)" dense onClick={onClose}>
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      )}

      {target?.kind === 'commit' && (
        <>
          <div className="git-commit-head">
            <div className="git-commit-head-top">
              <span className="git-commit-head-subject">
                {detail?.ok
                  ? detail.meta.subject
                  : detail && !detail.ok
                    ? detail.error
                    : 'Loading commit…'}
              </span>
              <span className="git-diff-esc">esc to close</span>
              <IconButton label="Close diff (esc)" dense onClick={onClose}>
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
            {detail?.ok && (
              <div className="git-commit-head-meta">
                <span className="git-commit-hash-chip">{detail.meta.shortHash}</span>
                <span>{detail.meta.author}</span>
                <span className="git-commit-meta-sep">·</span>
                <span title={new Date(detail.meta.time * 1000).toLocaleString()}>
                  {timeAgo(detail.meta.time)}
                </span>
                <span className="git-commit-meta-sep">·</span>
                <span>
                  {commitFiles.length} file{commitFiles.length === 1 ? '' : 's'}
                </span>
                <FileStat
                  additions={sumStat(commitFiles, 'additions')}
                  deletions={sumStat(commitFiles, 'deletions')}
                />
              </div>
            )}
          </div>
          {detail?.ok && detail.body && (
            <div className="git-commit-body-text">{unwrapCommitBody(detail.body)}</div>
          )}
          {commitFiles.length > 0 && (
            <div className="git-commit-files">
              {commitFiles.map((f, i) => (
                <div
                  key={f.path}
                  className={`git-commit-file ${i === commitFileIdx ? 'git-commit-file-active' : ''}`}
                  title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                  onClick={() => setCommitFileIdx(i)}
                >
                  <StatusLetter status={f.status} />
                  <span className="git-commit-file-path">{f.path}</span>
                  <FileStat additions={f.additions} deletions={f.deletions} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="git-diff-body">
        {diff?.error && <div className="git-diff-notice">{diff.error}</div>}
        {diff && !diff.error && <DiffBody text={diff.text} truncated={diff.truncated} />}
      </div>
    </div>
  )
}
