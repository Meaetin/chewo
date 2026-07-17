import { useEffect, useState } from 'react'
import type { Source } from '../../../shared/adapter/types'
import type { Project, Worktree } from '../../../shared/projects'

type WorktreeStatus = Awaited<ReturnType<typeof window.api.worktreeStatus>>

const TASK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

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
    <div className="copy-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="copy-modal worktree-modal" onClick={(e) => e.stopPropagation()}>
        <div className="copy-modal-title">New isolated terminal in {project.name}</div>

        <div className="copy-modal-section">
          <div className="copy-modal-label">Task name</div>
          <input
            className="worktree-task-input"
            placeholder="auth-fix"
            value={taskName}
            autoFocus
            onChange={(e) => setTaskName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameValid && !busy) void create()
            }}
          />
          {taskName && !nameValid && (
            <div className="worktree-hint worktree-hint-error">
              Letters, digits, dots, dashes, underscores — starts with a letter or digit
            </div>
          )}
          {nameValid && (
            <div className="worktree-hint">
              Branch <code>agent/{taskName}</code> in a separate checkout — merge back when done
            </div>
          )}
        </div>

        <div className="copy-modal-section">
          <div className="copy-modal-label">Agent</div>
          <label className="copy-modal-option">
            <input
              type="radio"
              checked={agent === 'claude'}
              onChange={() => setAgent('claude')}
            />
            Claude
          </label>
          <label className="copy-modal-option">
            <input type="radio" checked={agent === 'codex'} onChange={() => setAgent('codex')} />
            Codex
          </label>
        </div>

        <div className="copy-modal-section">
          <div className="copy-modal-label">Setup command (optional, saved per project)</div>
          <textarea
            className="worktree-setup-input"
            placeholder={`cp ${project.path}/.env . && npm install`}
            value={setup}
            rows={2}
            onChange={(e) => setSetup(e.target.value)}
          />
          <div className="worktree-hint">
            Runs visibly before the agent — gitignored files (.env, node_modules) don’t exist in
            a fresh worktree
          </div>
        </div>

        {error && <div className="worktree-error">{error}</div>}

        <div className="copy-modal-actions">
          <button className="copy-modal-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="copy-modal-apply" disabled={!nameValid || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
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
          ? `Merge conflict — aborted, your main checkout is untouched. Resolve in ${project.name} (or hand it to an agent):\n${res.error}`
          : res.error
      )
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Remove worktree and branch ${worktree.branch}?`)) return
    setBusy(true)
    setError(null)
    const err = await onRemove()
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  const ok = status?.ok ? status : null

  return (
    <div className="copy-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="copy-modal worktree-modal" onClick={(e) => e.stopPropagation()}>
        <div className="copy-modal-title">⎇ {worktree.taskName}</div>

        {!status && <div className="worktree-hint">Checking worktree…</div>}
        {status && !status.ok && <div className="worktree-error">{status.error}</div>}

        {ok && (
          <>
            <div className="worktree-hint">
              <code>{worktree.branch}</code> → <code>{ok.targetBranch}</code> (your main checkout)
            </div>

            {ok.dirty && (
              <div className="worktree-warning">
                Uncommitted changes in the worktree — ask the agent to commit before merging.
              </div>
            )}
            {merged && <div className="worktree-merged">Merged into {ok.targetBranch} ✓</div>}

            {ok.commits.length > 0 ? (
              <div className="copy-modal-section">
                <div className="copy-modal-label">
                  {ok.commits.length} commit{ok.commits.length === 1 ? '' : 's'} ahead
                </div>
                <pre className="worktree-pre">{ok.commits.join('\n')}</pre>
                {ok.diffStat && <pre className="worktree-pre">{ok.diffStat}</pre>}
              </div>
            ) : (
              !merged && <div className="worktree-hint">No commits ahead of {ok.targetBranch} yet.</div>
            )}
          </>
        )}

        {error && <div className="worktree-error">{error}</div>}

        <div className="copy-modal-actions">
          <button
            className="copy-modal-cancel worktree-remove-button"
            disabled={busy || !status}
            title="git worktree remove + branch -d — refuses if there is uncommitted or unmerged work"
            onClick={() => void remove()}
          >
            Remove worktree…
          </button>
          <button className="copy-modal-cancel" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button
            className="copy-modal-apply"
            disabled={busy || !ok || ok.dirty || ok.commits.length === 0}
            onClick={() => void merge()}
          >
            {busy ? 'Working…' : `Merge into ${ok?.targetBranch ?? '…'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
