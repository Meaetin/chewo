import { useEffect, useState } from 'react'
import type {
  AgentSettings,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  ProjectSettings
} from '../../../shared/projects'
import { DEFAULT_LOCAL_FILES } from '../../../shared/local-files'
import { projectScopeDir } from '../../../shared/todos'
import { ModalShell } from './ModalShell'
import { Select, type SelectOption } from './Select'
import { Badge, Button, Input } from './ui'

/**
 * Both CLIs start every fresh session at their own default and forget the mode
 * you flipped to last time. These labels describe what each value actually
 * does — the blast radius is the user's call, so nothing is preselected.
 */
const CLAUDE_MODES: SelectOption<ClaudePermissionMode | ''>[] = [
  { value: '', label: 'Ask every time', detail: 'Claude’s default — prompts on first use of each tool' },
  { value: 'plan', label: 'Plan', detail: 'Read and explore only, no edits' },
  { value: 'acceptEdits', label: 'Accept edits', detail: 'Auto-approves file edits and safe shell commands' },
  { value: 'auto', label: 'Auto', detail: 'Auto-approves, with a background safety classifier' },
  { value: 'dontAsk', label: 'Don’t ask', detail: 'Denies anything not pre-approved in your allow rules' },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    detail: 'Skips all prompts — no classifier, no guard rails'
  }
]

const CODEX_POLICIES: SelectOption<CodexApprovalPolicy | ''>[] = [
  { value: '', label: 'Ask every time', detail: 'Codex’s default' },
  { value: 'untrusted', label: 'Trusted commands only', detail: 'Runs ls/cat/sed etc., escalates the rest' },
  { value: 'on-request', label: 'Model decides', detail: 'Codex asks when it judges it necessary' },
  { value: 'never', label: 'Never ask', detail: 'Runs everything the sandbox allows without asking' }
]

interface SectionSettingsModalProps {
  /** Section name — a project's, or "Home" */
  name: string
  path: string
  settings: AgentSettings
  /** Absent for Home, which has no worktrees and no play button */
  project?: ProjectSettings
  onClose: () => void
  onSave: (settings: AgentSettings, project?: ProjectSettings) => void
  /** Projects only — Home can't be removed */
  onRemove?: (deleteBoard: boolean) => void
}

/** Per-section settings: how agents launch here, worktree setup, remove project. */
export function SectionSettingsModal({
  name,
  path,
  settings,
  project,
  onClose,
  onSave,
  onRemove
}: SectionSettingsModalProps): React.JSX.Element {
  const [claudeMode, setClaudeMode] = useState<ClaudePermissionMode | ''>(settings.claudeMode ?? '')
  const [codexApproval, setCodexApproval] = useState<CodexApprovalPolicy | ''>(
    settings.codexApproval ?? ''
  )
  const [setup, setSetup] = useState(project?.worktreeSetup ?? '')
  const [run, setRun] = useState(project?.runCommand ?? '')
  const [copy, setCopy] = useState(project?.worktreeCopy ?? '')
  const isProject = !!project

  const risky = claudeMode === 'bypassPermissions' || codexApproval === 'never'

  const save = (): void => {
    onSave(
      { claudeMode: claudeMode || undefined, codexApproval: codexApproval || undefined },
      isProject
        ? {
            worktreeSetup: setup.trim() || undefined,
            runCommand: run.trim() || undefined,
            worktreeCopy: copy.trim() || undefined
          }
        : undefined
    )
    onClose()
  }

  // Confirming inline rather than via window.confirm: the todo-board choice
  // needs a checkbox, and native dialogs can't carry one
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [deleteBoard, setDeleteBoard] = useState(false)
  const [boardCards, setBoardCards] = useState<number | null>(null)

  useEffect(() => {
    if (!confirmingRemove) return
    const scopeDir = projectScopeDir(name, path)
    void Promise.all([window.api.todosBoard(scopeDir), window.api.todosArchive(scopeDir)]).then(
      ([board, archive]) => setBoardCards(Object.keys(board.cards).length + archive.cards.length)
    )
  }, [confirmingRemove, name, path])

  const remove = (): void => {
    if (!confirmingRemove) {
      setConfirmingRemove(true)
      return
    }
    onRemove?.(deleteBoard)
    onClose()
  }

  return (
    <ModalShell
      title={`${name} settings`}
      subtitle={<code>{path}</code>}
      onClose={onClose}
      footer={
        <>
          {onRemove && (
            <Button
              intent="danger"
              title="Remove this project from Chewo — the folder and its sessions stay"
              onClick={remove}
            >
              {confirmingRemove ? `Really remove ${name}?` : 'Remove Project'}
            </Button>
          )}
          <div className="wt-footer-spacer" />
          <Button intent="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="wt-field">
        <label className="wt-field-label" htmlFor="set-claude">
          <Badge source="claude" /> Claude permission mode
        </label>
        <Select id="set-claude" value={claudeMode} options={CLAUDE_MODES} onChange={setClaudeMode} />
        <div className="wt-field-hint">
          {CLAUDE_MODES.find((m) => m.value === claudeMode)?.detail}
        </div>
      </div>

      <div className="wt-field">
        <label className="wt-field-label" htmlFor="set-codex">
          <Badge source="codex" /> Codex approval policy
        </label>
        <Select
          id="set-codex"
          value={codexApproval}
          options={CODEX_POLICIES}
          onChange={setCodexApproval}
        />
        <div className="wt-field-hint">
          {CODEX_POLICIES.find((p) => p.value === codexApproval)?.detail}
        </div>
      </div>

      {isProject && (
        <div className="wt-field">
          <label className="wt-field-label" htmlFor="set-run">
            Start command <span className="wt-field-optional">optional</span>
          </label>
          <Input
            id="set-run"
            variant="textarea"
            mono
            placeholder="npm run dev"
            value={run}
            rows={2}
            onChange={(e) => setRun(e.target.value)}
          />
          <div className="wt-field-hint">
            The project’s ▶ button launches these in Shell — one shell per line. Defaults to{' '}
            <code>npm run dev</code>.
          </div>
        </div>
      )}

      {isProject && (
        <div className="wt-field">
          <label className="wt-field-label" htmlFor="set-copy">
            Copy into new worktrees <span className="wt-field-optional">optional</span>
          </label>
          <Input
            id="set-copy"
            variant="textarea"
            mono
            placeholder={DEFAULT_LOCAL_FILES.join('\n')}
            value={copy}
            rows={3}
            onChange={(e) => setCopy(e.target.value)}
          />
          <div className="wt-field-hint">
            A worktree checks out tracked files only, so git-ignored ones like <code>.env</code>{' '}
            are missing. These are copied in before the agent starts — one gitignore-style pattern
            per line, <code>!</code> to exclude. Empty uses the defaults shown. Only files git
            already ignores travel, so Ship can never commit one;{' '}
            <code>node_modules</code> is cloned separately.
          </div>
        </div>
      )}

      {isProject && (
        <div className="wt-field">
          <label className="wt-field-label" htmlFor="set-setup">
            Worktree setup command <span className="wt-field-optional">optional</span>
          </label>
          <Input
            id="set-setup"
            variant="textarea"
            mono
            placeholder="npm run codegen"
            value={setup}
            rows={2}
            onChange={(e) => setSetup(e.target.value)}
          />
          <div className="wt-field-hint">
            Runs visibly in a fresh worktree before the agent starts
          </div>
        </div>
      )}

      {confirmingRemove && (
        <div className="wt-banner wt-banner-warning">
          <strong>Remove {name} from Chewo?</strong> The folder and its sessions are not deleted —
          only this project entry and its remembered terminals.
          <label className="wt-checkbox">
            <input
              type="checkbox"
              checked={deleteBoard}
              onChange={(e) => setDeleteBoard(e.target.checked)}
            />
            Also delete its todo board
            {boardCards === null ? '' : ` (${boardCards} card${boardCards === 1 ? '' : 's'})`}
          </label>
        </div>
      )}

      <div className="wt-banner wt-banner-neutral">
        Applies to terminals started in {name} from now on — running ones keep the mode they
        launched with.
      </div>

      {risky && (
        <div className="wt-banner wt-banner-warning">
          <strong>No approval prompts.</strong> An agent here can run any command without asking —
          including outside this folder. A worktree doesn’t contain this: it isolates files, not
          your shell, your <code>.git</code> remotes, or your network.
        </div>
      )}
    </ModalShell>
  )
}
