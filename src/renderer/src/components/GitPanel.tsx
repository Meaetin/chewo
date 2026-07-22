import { useEffect, useState } from 'react'
import { GitBranch, X } from 'lucide-react'
import type { ChangedFile, CommitMeta, FileStatus, RepoStatus } from '../../../main/git'
import { Dot, IconButton } from './ui'

/** What the diff layer is showing — drives row highlights here too */
export type GitSelection =
  | { kind: 'file'; file: ChangedFile }
  | { kind: 'commit'; hash: string }

const LETTER_CLASS: Record<FileStatus, string> = {
  M: 'git-letter-modified',
  T: 'git-letter-modified',
  A: 'git-letter-added',
  D: 'git-letter-deleted',
  R: 'git-letter-renamed',
  C: 'git-letter-renamed',
  U: 'git-letter-conflict',
  '?': 'git-letter-added'
}

const LETTER_TITLE: Record<FileStatus, string> = {
  M: 'Modified',
  T: 'Type changed',
  A: 'New file',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Merge conflict',
  '?': 'New file (untracked)'
}

export function StatusLetter({ status }: { status: FileStatus }): React.JSX.Element {
  // Untracked renders as "A": to a user glancing at the list a new file is a
  // new file — "?" reads as ambiguity, not newness
  return (
    <span className={`git-letter ${LETTER_CLASS[status]}`} title={LETTER_TITLE[status]}>
      {status === '?' ? 'A' : status}
    </span>
  )
}

export function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

export function FileStat({
  additions,
  deletions
}: Pick<ChangedFile, 'additions' | 'deletions'>): React.JSX.Element | null {
  if (additions === null && deletions === null) return null
  return (
    <span className="git-file-stat">
      {additions !== null && additions > 0 && <span className="git-stat-add">+{additions}</span>}
      {deletions !== null && deletions > 0 && <span className="git-stat-del">−{deletions}</span>}
    </span>
  )
}

interface GitPanelProps {
  visible: boolean
  /** Effective repo root for the active tab — worktree path when isolated */
  root: string
  /** Header text — basename of the root, ⎇-prefixed for worktrees */
  rootLabel: string
  /** Live status owned by App (also feeds the toggle badge) */
  status: RepoStatus | null
  /** What the diff layer is showing, for row highlights */
  selection: GitSelection | null
  onShowFile: (file: ChangedFile) => void
  onShowCommit: (hash: string) => void
  onClose: () => void
}

const LOG_LIMIT = 100

/**
 * Read-only git sidebar: Changes (live working-tree status) and History
 * (recent commits). Clicking a row opens the diff layer over the terminal —
 * this panel never mutates the repo.
 */
export function GitPanel({
  visible,
  root,
  rootLabel,
  status,
  selection,
  onShowFile,
  onShowCommit,
  onClose
}: GitPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [commits, setCommits] = useState<CommitMeta[] | null>(null)

  const repo = status?.ok && status.isRepo ? status : null
  const headOid = repo?.headOid ?? null

  // History follows HEAD: refetch when it moves (commit, merge, branch switch)
  useEffect(() => {
    setCommits(null)
  }, [root])
  useEffect(() => {
    if (!visible || tab !== 'history') return
    let cancelled = false
    void window.api.gitLog({ root, limit: LOG_LIMIT }).then((res) => {
      if (!cancelled && res.ok) setCommits(res.commits)
    })
    return () => {
      cancelled = true
    }
  }, [visible, tab, root, headOid])

  const files = repo?.files ?? []

  return (
    <div className="git-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="git-panel-header">
        <GitBranch className="git-branch-icon" size={13} strokeWidth={1.75} />
        <span className="git-branch-name" title={`${rootLabel} — ${root}`}>
          {repo ? repo.branch : rootLabel}
        </span>
        {repo?.upstream && (
          <span
            className="git-ahead-behind"
            title={`${repo.ahead} ahead, ${repo.behind} behind ${repo.upstream}`}
          >
            ↑{repo.ahead} ↓{repo.behind}
          </span>
        )}
        <IconButton label="Hide git (⌘⇧G)" dense onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="git-panel-tabs">
        <button
          className={`git-panel-tab ${tab === 'changes' ? 'git-panel-tab-active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
          {files.length > 0 && <span className="git-panel-tab-count">{files.length}</span>}
        </button>
        <button
          className={`git-panel-tab ${tab === 'history' ? 'git-panel-tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {status && !repo ? (
        <div className="git-panel-empty">
          {status.ok ? 'Not a git repository' : status.error}
        </div>
      ) : tab === 'changes' ? (
        <div className="git-panel-list">
          {repo && files.length === 0 && (
            <div className="git-panel-empty">Working tree clean</div>
          )}
          {files.map((f) => {
            const { dir, name } = splitPath(f.path)
            const active = selection?.kind === 'file' && selection.file.path === f.path
            return (
              <div
                key={f.path}
                className={`git-file-row ${active ? 'git-file-row-active' : ''}`}
                title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                onClick={() => onShowFile(f)}
              >
                <StatusLetter status={f.status} />
                <span className="git-file-path">
                  <span className="git-file-name">{name}</span>
                  {dir && <span className="git-file-dir">{dir}</span>}
                </span>
                <FileStat additions={f.additions} deletions={f.deletions} />
              </div>
            )
          })}
        </div>
      ) : (
        <div className="git-panel-list">
          {commits && commits.length === 0 && (
            <div className="git-panel-empty">No commits yet</div>
          )}
          {(commits ?? []).map((c) => {
            const active = selection?.kind === 'commit' && selection.hash === c.hash
            const isHead = c.refs.some((r) => r.startsWith('HEAD'))
            return (
              <div
                key={c.hash}
                className={`git-commit-row ${active ? 'git-commit-row-active' : ''}`}
                onClick={() => onShowCommit(c.hash)}
              >
                <span className="git-commit-rail">
                  <span className="git-commit-dot" />
                  <span className="git-commit-line" />
                </span>
                <span className="git-commit-body">
                  <span className="git-commit-subject" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="git-commit-meta">
                    <span className="git-commit-hash">{c.shortHash}</span>
                    <span>{c.author}</span>
                    <span>{timeAgo(c.time)}</span>
                    {isHead && <span className="git-commit-head-tag">HEAD</span>}
                  </span>
                </span>
              </div>
            )
          })}
          {commits && commits.length === LOG_LIMIT && (
            <div className="git-panel-more">last {LOG_LIMIT} commits</div>
          )}
        </div>
      )}

      {repo && (
        <div className="git-panel-foot">
          <Dot tone="live" className="git-panel-foot-dot" />
          watching for changes
        </div>
      )}
    </div>
  )
}
