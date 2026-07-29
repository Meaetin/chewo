import { useEffect, useState } from 'react'
import { ArrowRight, GitBranch, RotateCw } from 'lucide-react'
import type { Source } from '../../../shared/adapter/types'
import type { Project, Worktree } from '../../../shared/projects'
import { ModalShell } from './ModalShell'
import { Select, type SelectOption } from './Select'
import { Badge, Button, IconButton, Input } from './ui'

type WorktreeStatus = Awaited<ReturnType<typeof window.api.worktreeStatus>>

const TASK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

interface CreateModalProps {
  project: Project
  onCancel: () => void
  /** Returns an error message, or null on success (modal closes itself) */
  onCreate: (
    taskName: string,
    agent: Source,
    setup: string,
    base: string
  ) => Promise<string | null>
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
  const [base, setBase] = useState('')
  const [baseOptions, setBaseOptions] = useState<SelectOption<string>[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameValid = TASK_NAME_RE.test(taskName)

  // Branch list is read once on open — a stale entry just fails the create,
  // and refetching per keystroke would spawn git processes on every render.
  useEffect(() => {
    let live = true
    void window.api.worktreeBranches(project.path).then((res) => {
      if (!live) return
      if (!res.ok) {
        setBaseOptions([])
        setError(res.error)
        return
      }
      setBase(res.current)
      setBaseOptions([
        ...res.local.map((b) => ({
          value: b,
          label: b,
          ...(b === res.current && { detail: 'current' })
        })),
        ...res.remote.map((b) => ({ value: b, label: b, detail: 'remote' }))
      ])
    })
    return () => {
      live = false
    }
  }, [project.path])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const err = await onCreate(taskName, agent, setup, base)
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <ModalShell
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
          <div className="wt-footer-spacer" />
          <Button intent="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            intent="primary"
            loading={busy}
            loadingText="Creating…"
            disabled={!nameValid || !base}
            onClick={() => void create()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="wt-field">
        <label className="wt-field-label" htmlFor="wt-task">
          Task name
        </label>
        <Input
          id="wt-task"
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
        <label className="wt-field-label" htmlFor="wt-base">
          Branch from
        </label>
        {baseOptions === null ? (
          <div className="wt-field-hint">Reading branches…</div>
        ) : baseOptions.length === 0 ? (
          <div className="wt-field-hint">No branches found in this repository</div>
        ) : (
          <>
            <Select id="wt-base" value={base} options={baseOptions} onChange={setBase} />
            <div className="wt-field-hint">
              {nameValid ? <code>agent/{taskName}</code> : 'The new branch'} starts at{' '}
              <code>{base}</code> — not at whatever your main checkout is on
            </div>
          </>
        )}
      </div>

      <div className="wt-field">
        <div className="wt-field-label">Agent</div>
        <div className="wt-agent-choice">
          <button
            className={`wt-agent-option ${agent === 'claude' ? 'wt-agent-option-active' : ''}`}
            onClick={() => setAgent('claude')}
          >
            <Badge source="claude" /> Claude
          </button>
          <button
            className={`wt-agent-option ${agent === 'codex' ? 'wt-agent-option-active' : ''}`}
            onClick={() => setAgent('codex')}
          >
            <Badge source="codex" /> Codex
          </button>
        </div>
      </div>

      <div className="wt-field">
        <label className="wt-field-label" htmlFor="wt-setup">
          Setup command <span className="wt-field-optional">optional · saved for this project</span>
        </label>
        <Input
          id="wt-setup"
          variant="textarea"
          mono
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
    </ModalShell>
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
  /** Cleared on every refresh — consenting to one target must not outlive it */
  const [acceptedTarget, setAcceptedTarget] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setStatus(null)
    setAcceptedTarget(null)
    setStatus(
      await window.api.worktreeStatus({
        projectPath: project.path,
        worktreePath: worktree.path,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch
      })
    )
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.id])

  const merge = async (): Promise<void> => {
    if (!status?.ok) return
    setBusy(true)
    setError(null)
    const res = await window.api.worktreeMerge({
      projectPath: project.path,
      branch: worktree.branch,
      expectedTarget: status.targetBranch
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
  // Landing somewhere other than the branch this work was based on is a
  // deliberate act, never a default — another agent sharing the checkout can
  // move HEAD at any moment.
  const targetOk = !!ok && !ok.detached && (ok.targetIsLanding || acceptedTarget === ok.targetBranch)
  const canMerge = !!ok && targetOk && !ok.dirty && ok.commits.length > 0 && !busy

  return (
    <ModalShell
      title={
        <>
          <GitBranch className="wt-modal-glyph" size={16} strokeWidth={1.75} /> {worktree.taskName}
        </>
      }
      subtitle={
        ok ? (
          <>
            <code>{worktree.branch}</code>
            <ArrowRight className="wt-arrow" size={14} strokeWidth={1.75} aria-hidden="true" />
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
          <Button
            intent="danger"
            disabled={busy || !status}
            title="git worktree remove + branch -d — refuses if work is uncommitted or unmerged"
            onClick={() => void remove()}
          >
            Remove worktree…
          </Button>
          <div className="wt-footer-spacer" />
          <Button
            intent="primary"
            loading={busy}
            loadingText="Merging…"
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
            {`Merge into ${ok?.targetBranch ?? 'main'}`}
          </Button>
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

          {ok.detached && (
            <div className="wt-banner wt-banner-error">
              <strong>{project.name} is on no branch.</strong> Its checkout has a detached HEAD, so
              a merge would leave these commits unreachable. Check out{' '}
              <code>{ok.landingBranch}</code> there first.
            </div>
          )}

          {!ok.detached && !ok.targetIsLanding && (
            <div className="wt-banner wt-banner-error">
              <strong>Main checkout moved.</strong> This branch was meant to land on{' '}
              <code>{ok.landingBranch}</code>, but {project.name} is currently on{' '}
              <code>{ok.targetBranch}</code> — something switched it, often an agent running there
              that branched. Merging now lands your work on <code>{ok.targetBranch}</code>, and the
              commits below are only what <code>{ok.targetBranch}</code> lacks, so they can include
              work that isn’t yours. Check out <code>{ok.landingBranch}</code> in {project.name}{' '}
              first — or merge here deliberately.
              <div className="wt-banner-actions">
                {acceptedTarget === ok.targetBranch ? (
                  <strong>Merging into {ok.targetBranch}.</strong>
                ) : (
                  <Button onClick={() => setAcceptedTarget(ok.targetBranch)}>
                    Merge into {ok.targetBranch} anyway
                  </Button>
                )}
                <Button onClick={() => void refresh()}>Re-check</Button>
              </div>
            </div>
          )}

          {ok.commits.length > 0 ? (
            <>
              <div className="wt-section-head">
                <span className="wt-field-label">
                  {ok.commits.length} commit{ok.commits.length === 1 ? '' : 's'} ahead of{' '}
                  {ok.targetBranch}
                </span>
                <IconButton
                  label="Re-check the worktree"
                  dense
                  onClick={() => void refresh()}
                >
                  <RotateCw size={14} strokeWidth={1.75} />
                </IconButton>
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
                <Button
                  intent="secondary"
                  className="wt-refresh-wide"
                  leadingIcon={<RotateCw size={16} strokeWidth={1.75} />}
                  onClick={() => void refresh()}
                >
                  Refresh
                </Button>
              </div>
            )
          )}
        </>
      )}

      {error && <div className="wt-banner wt-banner-error">{error}</div>}
    </ModalShell>
  )
}
