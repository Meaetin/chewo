import { useEffect, useState } from 'react'
import type { Source } from '../../../shared/adapter/types'
import type { Project, Worktree } from '../../../shared/projects'

type WorktreeStatus = Awaited<ReturnType<typeof window.api.worktreeStatus>>

const TASK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

interface ShellProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Blocked while a git command is in flight — closing mid-merge would strand the UI */
  busy: boolean
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}

/** Modal chrome shared by both worktree dialogs: header + scrollable body + fixed footer. */
function WorktreeModalShell({
  title,
  subtitle,
  busy,
  onClose,
  children,
  footer
}: ShellProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="wt-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="wt-modal" onClick={(e) => e.stopPropagation()}>
        <header className="wt-modal-header">
          <div className="wt-modal-heading">
            <div className="wt-modal-title">{title}</div>
            {subtitle && <div className="wt-modal-subtitle">{subtitle}</div>}
          </div>
          <button className="wt-modal-close" title="Close (Esc)" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="wt-modal-body">{children}</div>
        <footer className="wt-modal-footer">{footer}</footer>
      </div>
    </div>
  )
}

interface CreateModalProps {
  project: Project
  onCancel: () => void
  /** Returns an error message, or null on success (modal closes itself) */
  onCreate: (taskName: string, agent: Source, setup: string) => Promise<string | null>
}

/** "New isolated terminal" — task name → branch agent/<task> in its own worktree. */
export function WorktreeCreateModal({
  project,
  onCancel,
  onCreate
}: CreateModalProps): React.JSX.Element {
  const [taskName, setTaskName] = useState('')
  const [agent, setAgent] = useState<Source>('claude')
  const [setup, setSetup] = useState(project.worktreeSetup ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameValid = TASK_NAME_RE.test(taskName)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const err = await onCreate(taskName, agent, setup)
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <WorktreeModalShell
      title="New isolated terminal"
      subtitle={
        <>
          in <strong>{project.name}</strong> — the agent works on its own branch, your main
          checkout keeps running
        </>
      }
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button className="wt-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="wt-button wt-button-primary"
            disabled={!nameValid || busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="wt-field">
        <label className="wt-field-label" htmlFor="wt-task">
          Task name
        </label>
        <input
          id="wt-task"
          className="wt-input"
          placeholder="auth-fix"
          value={taskName}
          autoFocus
          onChange={(e) => setTaskName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && nameValid && !busy) void create()
          }}
        />
        {taskName && !nameValid ? (
          <div className="wt-field-hint wt-field-hint-error">
            Letters, digits, dots, dashes, underscores — starts with a letter or digit
          </div>
        ) : (
          <div className="wt-field-hint">
            {nameValid ? (
              <>
                Branch <code>agent/{taskName}</code> · tab <code>⎇ {taskName}</code>
              </>
            ) : (
              'Names the branch, the worktree folder, and the tab'
            )}
          </div>
        )}
      </div>

      <div className="wt-field">
        <div className="wt-field-label">Agent</div>
        <div className="wt-agent-choice">
          <button
            className={`wt-agent-option ${agent === 'claude' ? 'wt-agent-option-active' : ''}`}
            onClick={() => setAgent('claude')}
          >
            <span className="source-badge source-badge-claude">CC</span> Claude
          </button>
          <button
            className={`wt-agent-option ${agent === 'codex' ? 'wt-agent-option-active' : ''}`}
            onClick={() => setAgent('codex')}
          >
            <span className="source-badge source-badge-codex">CX</span> Codex
          </button>
        </div>
      </div>

      <div className="wt-field">
        <label className="wt-field-label" htmlFor="wt-setup">
          Setup command <span className="wt-field-optional">optional · saved for this project</span>
        </label>
        <textarea
          id="wt-setup"
          className="wt-input wt-input-mono"
          placeholder={`cp ${project.path}/.env . && npm install`}
          value={setup}
          rows={2}
          onChange={(e) => setSetup(e.target.value)}
        />
        <div className="wt-field-hint">
          Runs visibly before the agent starts — gitignored files (.env, node_modules) don’t exist
          in a fresh worktree
        </div>
      </div>

      {error && <div className="wt-banner wt-banner-error">{error}</div>}
    </WorktreeModalShell>
  )
}

interface MergeModalProps {
  worktree: Worktree
  project: Project
  onClose: () => void
  /** App kills panes, runs git worktree remove, drops records. Error message or null. */
  onRemove: () => Promise<string | null>
}

/** Review & merge: dirty check → commits/diffstat → merge into main checkout → cleanup. */
export function WorktreeMergeModal({
  worktree,
  project,
  onClose,
  onRemove
}: MergeModalProps): React.JSX.Element {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [merged, setMerged] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setStatus(null)
    setStatus(
      await window.api.worktreeStatus({
        projectPath: project.path,
        worktreePath: worktree.path,
        branch: worktree.branch
      })
    )
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.id])

  const merge = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await window.api.worktreeMerge({
      projectPath: project.path,
      branch: worktree.branch
    })
    setBusy(false)
    if (res.ok) {
      setMerged(true)
      void refresh()
    } else {
      setError(
        res.aborted
          ? `Merge conflict — aborted. Your main checkout is untouched. Resolve it in ${project.name} (or hand it to an agent), then merge again.\n\n${res.error}`
          : res.error
      )
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Remove the worktree and delete branch ${worktree.branch}?`)) return
    setBusy(true)
    setError(null)
    const err = await onRemove()
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  const ok = status?.ok ? status : null
  const canMerge = !!ok && !ok.dirty && ok.commits.length > 0 && !busy

  return (
    <WorktreeModalShell
      title={
        <>
          <span className="wt-modal-glyph">⎇</span> {worktree.taskName}
        </>
      }
      subtitle={
        ok ? (
          <>
            <code>{worktree.branch}</code>
            <span className="wt-arrow">→</span>
            <code>{ok.targetBranch}</code>
            <span className="wt-subtitle-note">your main checkout</span>
          </>
        ) : (
          <code>{worktree.branch}</code>
        )
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button
            className="wt-button wt-button-danger"
            disabled={busy || !status}
            title="git worktree remove + branch -d — refuses if work is uncommitted or unmerged"
            onClick={() => void remove()}
          >
            Remove worktree…
          </button>
          <div className="wt-footer-spacer" />
          <button
            className="wt-button wt-button-primary"
            disabled={!canMerge}
            title={
              !ok
                ? undefined
                : ok.dirty
                  ? 'The agent has uncommitted changes — ask it to commit first'
                  : ok.commits.length === 0
                    ? 'Nothing to merge yet'
                    : `git merge --no-ff ${worktree.branch}`
            }
            onClick={() => void merge()}
          >
            {busy ? 'Merging…' : `Merge into ${ok?.targetBranch ?? 'main'}`}
          </button>
        </>
      }
    >
      {!status && <div className="wt-empty">Checking worktree…</div>}
      {status && !status.ok && <div className="wt-banner wt-banner-error">{status.error}</div>}

      {ok && (
        <>
          {merged && (
            <div className="wt-banner wt-banner-success">
              Merged into {ok.targetBranch} — your dev servers should have picked it up. Remove the
              worktree when you’re done with it.
            </div>
          )}

          {ok.dirty && (
            <div className="wt-banner wt-banner-warning">
              <strong>Uncommitted changes in the worktree.</strong> Ask the agent to commit its
              work, then refresh — merging now would leave it behind.
            </div>
          )}

          {ok.commits.length > 0 ? (
            <>
              <div className="wt-section-head">
                <span className="wt-field-label">
                  {ok.commits.length} commit{ok.commits.length === 1 ? '' : 's'} ahead of{' '}
                  {ok.targetBranch}
                </span>
                <button className="wt-refresh" title="Re-check the worktree" onClick={() => void refresh()}>
                  ↻
                </button>
              </div>
              <ul className="wt-commit-list">
                {ok.commits.map((c) => {
                  const sha = c.slice(0, c.indexOf(' '))
                  return (
                    <li key={c} className="wt-commit">
                      <code className="wt-commit-sha">{sha}</code>
                      <span className="wt-commit-subject">{c.slice(sha.length + 1)}</span>
                    </li>
                  )
                })}
              </ul>
              {ok.diffStat && <pre className="wt-diffstat">{ok.diffStat}</pre>}
            </>
          ) : (
            !merged && (
              <div className="wt-empty">
                <div className="wt-empty-title">Nothing to merge yet</div>
                <p>
                  {ok.dirty
                    ? 'The agent has changes but hasn’t committed them.'
                    : `No commits on this branch yet — the agent hasn’t written anything.`}
                </p>
                <button className="wt-button wt-refresh-wide" onClick={() => void refresh()}>
                  ↻ Refresh
                </button>
              </div>
            )
          )}
        </>
      )}

      {error && <div className="wt-banner wt-banner-error">{error}</div>}
    </WorktreeModalShell>
  )
}
