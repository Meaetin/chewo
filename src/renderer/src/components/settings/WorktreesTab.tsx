import type { WorktreeSettings } from '../../../../shared/worktree-settings'

/**
 * What happens to an isolated branch after its work lands.
 *
 * Only the default lives here — the merge modal carries the same checkbox, so
 * a one-off "keep this checkout" never needs a trip to settings.
 */

interface WorktreesTabProps {
  worktrees: WorktreeSettings
  onChange: (w: WorktreeSettings) => void
}

export function WorktreesTab({ worktrees, onChange }: WorktreesTabProps): React.JSX.Element {
  return (
    <div className="settings-worktrees">
      <label className="settings-worktrees-option">
        <input
          type="checkbox"
          checked={worktrees.autoCleanupOnMerge}
          onChange={(e) => onChange({ ...worktrees, autoCleanupOnMerge: e.target.checked })}
        />
        <span className="settings-worktrees-copy">
          <span className="settings-worktrees-name">Clean up after a merge</span>
          <span className="settings-worktrees-detail">
            When a merge lands from the review modal, remove the worktree and delete its branch.
          </span>
        </span>
      </label>
      <p className="settings-worktrees-footnote">
        Cleanup runs <code>git worktree remove</code> and <code>git branch -d</code> unforced, so
        git still refuses when the checkout has uncommitted files or the branch holds commits the
        merge didn’t take. On a refusal the worktree is kept and git’s own reason is shown, so
        nothing is ever lost by leaving this on. Removing a checkout does close any terminal running
        in it.
      </p>
    </div>
  )
}
