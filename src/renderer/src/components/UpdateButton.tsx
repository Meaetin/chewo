import { useState } from 'react'
import { ArrowDownToLine, Loader2 } from 'lucide-react'
import type { RepoStatus } from '../../../main/git'
import { Tooltip } from './ui'

interface UpdateButtonProps {
  root: string
  status: RepoStatus | null
  onDone: (message: string) => void
  onError: (message: string) => void
}

/**
 * "Main moved — give me those commits." Deliberately not labelled Pull:
 * `git pull` in a session's worktree fails with *no upstream configured for
 * branch 'agent/foo'*, because a task branch has no upstream until Ship gives
 * it one. What this actually runs is a fetch plus either a fast-forward (on
 * the default branch) or a merge of `origin/<default>` (on a task branch) —
 * main deciding which, from the checkout it is pointed at.
 *
 * Rendered only when the checkout is actually behind. The tab bar's width is
 * the tabs' to spend, and a button that is a no-op in the common case is the
 * cheapest thing in it to give back — a session cut minutes ago is level with
 * its base, and pressing this then fetches and merges nothing. The count it
 * used to carry as a badge *is* its visibility now.
 */
export function UpdateButton({
  root,
  status,
  onDone,
  onError
}: UpdateButtonProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const repo = status?.ok && status.isRepo ? status : null
  // `busy` keeps it mounted through its own run: the update is what makes the
  // checkout level again, so the status that lands mid-flight is precisely the
  // one that would otherwise pull the spinner off screen.
  if (!repo || (repo.behind === 0 && !busy)) return null

  const update = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.api.gitUpdate(root)
      if (res.ok) onDone(res.message)
      else onError(res.error)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip
      label={
        busy
          ? 'Updating…'
          : `${repo.behind} commit${repo.behind === 1 ? '' : 's'} on ${
              repo.baseRef ?? repo.upstream ?? 'the default branch'
            } aren’t in this checkout — fetch and bring them in`
      }
      side="top"
    >
      <button
        type="button"
        className="update-button"
        disabled={busy}
        aria-label="Update from the default branch"
        onClick={() => void update()}
      >
        {busy ? (
          <Loader2 className="update-button-spin" size={13} strokeWidth={2} aria-hidden="true" />
        ) : (
          <ArrowDownToLine size={13} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="update-button-label">Update</span>
        {!busy && repo.behind > 0 && <span className="update-button-count">{repo.behind}</span>}
      </button>
    </Tooltip>
  )
}
