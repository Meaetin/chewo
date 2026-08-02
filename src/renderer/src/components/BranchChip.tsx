import { useState } from 'react'
import { ArrowDownToLine, GitBranch, Loader2 } from 'lucide-react'
import type { RepoStatus } from '../../../main/git'
import { Tooltip } from './ui'

/**
 * What the focused session's checkout is, and the one thing you can still do
 * to it from here.
 *
 * This replaced a full branch menu — list, switch, create, fetch, pull, push.
 * All of that assumed sessions share one checkout and you move it around
 * between them. They don't any more: a session *is* a checkout, so switching
 * is starting another session, pushing is Ship, and fetch only ever existed to
 * serve the other two. The label is therefore read-only, and the only action
 * is the one a running session can genuinely need: main moved, give me those
 * commits.
 */

interface BranchChipProps {
  /** Header text — basename of the root, ⎇-prefixed for worktrees */
  rootLabel: string
  /** Live status owned by App; the chip reads its branch and ahead/behind */
  status: RepoStatus | null
}

export function BranchChip({ rootLabel, status }: BranchChipProps): React.JSX.Element | null {
  const repo = status?.ok && status.isRepo ? status : null
  // Nothing to show until status says this root really is a repo — a chip that
  // appears and then vanishes reads as a glitch
  if (!repo) return null

  const dirty = repo.files.length
  const detail = [
    rootLabel,
    repo.upstream ?? 'no upstream',
    dirty > 0 ? `${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}` : 'clean'
  ].join(' · ')

  return (
    <Tooltip label={detail} side="top">
      <span className="branch-chip">
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="branch-chip-name">{repo.branch}</span>
        {(repo.ahead > 0 || repo.behind > 0) && (
          <span className="branch-chip-track">
            {repo.ahead > 0 && `↑${repo.ahead}`}
            {repo.behind > 0 && `↓${repo.behind}`}
          </span>
        )}
      </span>
    </Tooltip>
  )
}

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
 */
export function UpdateButton({
  root,
  status,
  onDone,
  onError
}: UpdateButtonProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const repo = status?.ok && status.isRepo ? status : null
  if (!repo) return null

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
          : 'Fetch and bring the default branch’s new commits into this checkout'
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
