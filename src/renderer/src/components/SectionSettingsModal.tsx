import { useState } from 'react'
import type {
  AgentSettings,
  ClaudePermissionMode,
  CodexApprovalPolicy
} from '../../../shared/projects'
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
  /** Projects only — Home has no worktrees */
  worktreeSetup?: string
  /** Projects only — commands the tab-bar play button launches */
  runCommand?: string
  showWorktreeSetup: boolean
  onClose: () => void
  onSave: (settings: AgentSettings, worktreeSetup?: string, runCommand?: string) => void
  /** Projects only — Home can't be removed */
  onRemove?: () => void
}

/** Per-section settings: how agents launch here, worktree setup, remove project. */
export function SectionSettingsModal({
  name,
  path,
  settings,
  worktreeSetup,
  runCommand,
  showWorktreeSetup,
  onClose,
  onSave,
  onRemove
}: SectionSettingsModalProps): React.JSX.Element {
  const [claudeMode, setClaudeMode] = useState<ClaudePermissionMode | ''>(settings.claudeMode ?? '')
  const [codexApproval, setCodexApproval] = useState<CodexApprovalPolicy | ''>(
    settings.codexApproval ?? ''
  )
  const [setup, setSetup] = useState(worktreeSetup ?? '')
  const [run, setRun] = useState(runCommand ?? '')

  const risky = claudeMode === 'bypassPermissions' || codexApproval === 'never'

  const save = (): void => {
    onSave(
      { claudeMode: claudeMode || undefined, codexApproval: codexApproval || undefined },
      showWorktreeSetup ? setup.trim() || undefined : undefined,
      showWorktreeSetup ? run.trim() || undefined : undefined
    )
    onClose()
  }

  const remove = (): void => {
    if (
      !window.confirm(
        `Remove ${name} from Chewo?\n\nThe folder and its sessions are not deleted — only this project entry and its remembered terminals.`
      )
    )
      return
    onRemove?.()
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
              Remove Project
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

      {showWorktreeSetup && (
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
            The tab bar’s ▶ button launches these — one terminal per line. Defaults to{' '}
            <code>npm run dev</code>.
          </div>
        </div>
      )}

      {showWorktreeSetup && (
        <div className="wt-field">
          <label className="wt-field-label" htmlFor="set-setup">
            Worktree setup command <span className="wt-field-optional">optional</span>
          </label>
          <Input
            id="set-setup"
            variant="textarea"
            mono
            placeholder={`cp ${path}/.env . && npm install`}
            value={setup}
            rows={2}
            onChange={(e) => setSetup(e.target.value)}
          />
          <div className="wt-field-hint">
            Runs visibly in a fresh worktree before the agent starts
          </div>
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
