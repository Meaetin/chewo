import { useEffect, useState } from 'react'
import { ArrowRight, GitBranch, RotateCw } from 'lucide-react'
import type { Source } from '../../../shared/adapter/types'
import type { Project, Worktree } from '../../../shared/projects'
import { ModalShell } from './ModalShell'
import { Select, type SelectOption } from './Select'
import { Badge, Button, IconButton, Input } from './ui'


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
          placeholder="direnv allow"
          value={setup}
          rows={2}
          onChange={(e) => setSetup(e.target.value)}
        />
        <div className="wt-field-hint">
          Runs visibly before the agent starts. For side effects a copy can’t produce — a venv, a
          per-branch database, a trust decision. <code>.env</code> and <code>node_modules</code>{' '}
          arrive on their own.
        </div>
      </div>

      {error && <div className="wt-banner wt-banner-error">{error}</div>}
    </ModalShell>
  )
}

interface MergeModalProps {
  worktree: Worktree
  project: Project
  /** How many terminals a removal would close — the one cost cleanup can't undo */
  openTerminals: number
  onClose: () => void
  /** App kills panes, runs git worktree remove, drops records. Error message or null. */
  onRemove: () => Promise<string | null>
  /** Marks the branch finished by hand — for work that shipped as a squash/rebase */
  onMarkDone: () => void
  /** Settings default for cleaning up after a merge; the checkbox starts here */
  autoCleanup: boolean
  /** Ticking the checkbox rewrites the default, so the choice sticks */
  onAutoCleanupChange: (on: boolean) => void
}
