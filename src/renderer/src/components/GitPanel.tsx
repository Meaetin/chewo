import { useEffect, useState } from 'react'
import { ChevronRight, GitBranch, Trash2, Undo2, X } from 'lucide-react'
import type {
  ChangedFile,
  CommitMeta,
  FileStatus,
  RepoStatus,
  UntrackedFilesResult
} from '../../../main/git'
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

/** A file inside a collapsed untracked directory is untracked like its parent */
const untrackedChild = (path: string): ChangedFile => ({
  path,
  status: '?',
  staged: false,
  unstaged: true,
  additions: null,
  deletions: null
})

/**
 * Throw this row's change away.
 *
 * Two icons, because the two operations are genuinely different and a single
 * one would misdescribe half of them: a tracked file is *reverted* to what
 * HEAD says, an untracked file has no earlier version to go back to and is
 * *deleted*. Revealed on hover like the sidebar's own trailing controls — an
 * always-visible delete on every row is an invitation to a misclick.
 */
function DiscardButton({
  file,
  onDiscard
}: {
  file: ChangedFile
  onDiscard: (file: ChangedFile) => void
}): React.JSX.Element {
  const gone = file.status === '?'
  return (
    <span className="git-file-discard">
      <IconButton
        label={gone ? `Delete ${file.path}` : `Discard changes to ${file.path}`}
        onClick={(e) => {
          // The row opens the diff; this must not do both
          e.stopPropagation()
          onDiscard(file)
        }}
      >
        {gone ? (
          <Trash2 size={12} strokeWidth={1.75} />
        ) : (
          <Undo2 size={12} strokeWidth={1.75} />
        )}
      </IconButton>
    </span>
  )
}

function FileRow({
  file,
  label,
  active,
  nested,
  onClick,
  onDiscard
}: {
  file: ChangedFile
  /** Path to display — relative to the parent folder for nested rows */
  label: string
  active: boolean
  nested?: boolean
  onClick: () => void
  onDiscard?: (file: ChangedFile) => void
}): React.JSX.Element {
  const { dir, name } = splitPath(label)
  return (
    <div
      className={`git-file-row ${nested ? 'git-file-row-nested' : ''} ${active ? 'git-file-row-active' : ''}`}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      onClick={onClick}
    >
      <StatusLetter status={file.status} />
      <span className="git-file-path">
        <span className="git-file-name">{name}</span>
        {dir && <span className="git-file-dir">{dir}</span>}
      </span>
      <FileStat additions={file.additions} deletions={file.deletions} />
      {onDiscard && <DiscardButton file={file} onDiscard={onDiscard} />}
    </div>
  )
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
  /**
   * Throw a change away. Owned by App because it is unrecoverable: the
   * confirmation that names the loss, and the call itself, belong with the
   * other destructive actions rather than in the panel that draws the rows.
   * `count` is the file total for a collapsed untracked directory.
   */
  onDiscard: (file: ChangedFile, count?: number) => void
  onClose: () => void
}

const LOG_LIMIT = 100

/**
 * Git sidebar: Changes (live working-tree status) and History (recent
 * commits). Clicking a row opens the diff layer over the terminal.
 *
 * Reading is all it does on its own. The one mutation reachable from here —
 * discarding a change — is raised to App as `onDiscard` rather than called,
 * because it is unrecoverable and the confirmation that shows the loss belongs
 * with the app's other destructive actions.
 */
export function GitPanel({
  visible,
  root,
  rootLabel,
  status,
  selection,
  onShowFile,
  onShowCommit,
  onDiscard,
  onClose
}: GitPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [commits, setCommits] = useState<CommitMeta[] | null>(null)
  /** Untracked directories the user expanded, and their loaded contents */
  const [expanded, setExpanded] = useState<string[]>([])
  const [dirFiles, setDirFiles] = useState<Record<string, UntrackedFilesResult>>({})

  const repo = status?.ok && status.isRepo ? status : null
  const headOid = repo?.headOid ?? null

  // History follows HEAD: refetch when it moves (commit, merge, branch switch)
  useEffect(() => {
    setCommits(null)
    setExpanded([])
    setDirFiles({})
  }, [root])

  // An expanded folder's contents move under us like any other working-tree
  // state, so they reload whenever status does — never cached across a change
  useEffect(() => {
    if (!status || expanded.length === 0) return
    let cancelled = false
    for (const dir of expanded) {
      void window.api.gitUntrackedFiles({ root, dir }).then((res) => {
        if (!cancelled) setDirFiles((prev) => ({ ...prev, [dir]: res }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [root, status, expanded])
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

  const toggleDir = (dir: string): void =>
    setExpanded((prev) => (prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir]))

  return (
    <div className="git-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="git-panel-header">
        <GitBranch className="git-branch-icon" size={13} strokeWidth={1.75} />
        {/* The panel is where the tab bar's branch chip's detail went, so this
            carries the whole of it: which checkout, tracking what, how dirty */}
        <span
          className="git-branch-name"
          title={[
            `${rootLabel} — ${root}`,
            repo ? (repo.upstream ?? 'no upstream') : null,
            repo
              ? repo.files.length > 0
                ? `${repo.files.length} uncommitted change${repo.files.length === 1 ? '' : 's'}`
                : 'clean'
              : null
          ]
            .filter(Boolean)
            .join('\n')}
        >
          {repo ? repo.branch : rootLabel}
        </span>
        {repo && (repo.ahead > 0 || repo.behind > 0) && (
          <span
            className="git-ahead-behind"
            title={`${repo.ahead} ahead, ${repo.behind} behind ${repo.upstream ?? 'its base'}`}
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
            // git collapses a wholly-untracked directory into one entry; it has
            // no diff of its own, so the row expands into the files instead
            if (f.isDir) {
              const { dir, name } = splitPath(f.path.replace(/\/$/, ''))
              const open = expanded.includes(f.path)
              const loaded = dirFiles[f.path]
              return (
                <div key={f.path}>
                  <div className="git-file-row" title={f.path} onClick={() => toggleDir(f.path)}>
                    <ChevronRight
                      className={`git-dir-chevron ${open ? 'git-dir-chevron-open' : ''}`}
                      size={12}
                      strokeWidth={2.25}
                    />
                    <StatusLetter status={f.status} />
                    <span className="git-file-path">
                      <span className="git-file-name">{name}</span>
                      {dir && <span className="git-file-dir">{dir}</span>}
                    </span>
                    {loaded?.ok && (
                      <span className="git-dir-count">
                        {loaded.total} {loaded.total === 1 ? 'file' : 'files'}
                      </span>
                    )}
                    {/* The count is only known once the folder has been
                        expanded — until then the confirmation says "folder" */}
                    <DiscardButton
                      file={f}
                      onDiscard={() => onDiscard(f, loaded?.ok ? loaded.total : undefined)}
                    />
                  </div>
                  {open && !loaded && <div className="git-panel-more">reading folder…</div>}
                  {open && loaded?.ok === false && (
                    <div className="git-panel-more">{loaded.error}</div>
                  )}
                  {open &&
                    loaded?.ok &&
                    loaded.paths.map((p) => (
                      <FileRow
                        key={p}
                        nested
                        file={untrackedChild(p)}
                        label={p.slice(f.path.length)}
                        active={selection?.kind === 'file' && selection.file.path === p}
                        onClick={() => onShowFile(untrackedChild(p))}
                        onDiscard={onDiscard}
                      />
                    ))}
                  {open && loaded?.ok && loaded.total > loaded.paths.length && (
                    <div className="git-panel-more">
                      first {loaded.paths.length} of {loaded.total}
                    </div>
                  )}
                </div>
              )
            }
            return (
              <FileRow
                key={f.path}
                file={f}
                label={f.path}
                active={selection?.kind === 'file' && selection.file.path === f.path}
                onClick={() => onShowFile(f)}
                onDiscard={onDiscard}
              />
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
