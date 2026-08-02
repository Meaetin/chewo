import { GitPullRequestArrow, Loader2 } from 'lucide-react'
import type { RepoStatus } from '../../../main/git'
import { Tooltip } from './ui'

interface ShipButtonProps {
  /** Live status; only used to say what shipping would do before you open it */
  status: RepoStatus | null
  /** Reading the change — the wait happens here, so the dialog opens filled in */
  busy?: boolean
  onOpen: () => void
}

/**
 * Opens the Ship review for the focused session's checkout.
 *
 * It used to ship on the click, with no prompts — defensible when the work is
 * isolated, but Ship stages **everything not ignored**, and an agent's stray
 * scratch file looks exactly like the change you meant. One dialog between the
 * intent and the push buys back the only thing the automation cannot supply:
 * your eyes on the file list.
 */
export function ShipButton({ status, busy, onOpen }: ShipButtonProps): React.JSX.Element {
  const repo = status?.ok && status.isRepo ? status : null
  const dirty = repo?.files.length ?? 0
  const ahead = repo?.ahead ?? 0
  const label = busy
    ? 'Reading the change…'
    : dirty > 0
      ? `Review and ship ${dirty} ${dirty === 1 ? 'change' : 'changes'}`
      : ahead > 0
        ? `Review and ship ${ahead} ${ahead === 1 ? 'commit' : 'commits'}`
        : 'Review and ship this branch'

  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        className="ship-button"
        disabled={busy}
        aria-label={label}
        aria-busy={busy}
        onClick={onOpen}
      >
        {busy ? (
          <Loader2 className="ship-button-spin" size={13} strokeWidth={2} aria-hidden="true" />
        ) : (
          <GitPullRequestArrow size={13} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="ship-button-label">Ship</span>
        {!busy && dirty > 0 && <span className="ship-button-count">{dirty}</span>}
      </button>
    </Tooltip>
  )
}
