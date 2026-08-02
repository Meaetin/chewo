import { useState } from 'react'
import { GitPullRequestArrow } from 'lucide-react'
import type { ShipPreview, ShipSuccess } from '../../../main/git-ship'
import { ModalShell } from './ModalShell'
import { Button } from './ui'

interface ShipModalProps {
  /** Checkout being shipped — a worktree, or the project itself */
  root: string
  /** Header label; `⎇ task` for a worktree */
  rootLabel: string
  /**
   * Already resolved. The read costs a couple of API calls and a model call,
   * so it happens behind the Ship button's spinner — a dialog that opens onto
   * "Reading the change…" is a dialog that opened too early.
   */
  preview: ShipPreview
  /** Re-read after "Nothing to ship" — the button spins again, not the dialog */
  onRefresh: () => void
  onClose: () => void
  onShipped: (result: ShipSuccess) => void
  /** Offered only for a worktree — the checkout it would delete */
  onRemoveWorktree?: () => void
  onMarkDone?: () => void
}

/** `git status --porcelain` codes, in the words a person would use. */
const STATUS_WORDS: Record<string, string> = {
  '??': 'new',
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'retyped',
  U: 'conflicted'
}

/**
 * Read this, then ship it.
 *
 * Ship stages everything not ignored, which is the right default in a
 * worktree — `git status` there *is* one session's work — and still the one
 * thing worth a second pair of eyes, because an agent's stray scratch file is
 * indistinguishable from the change you meant. So the file list is the point
 * of this dialog, not the message; the message is here because you may as well
 * fix it while you are looking.
 *
 * The preview does no work (`shipPreview` stages nothing), so closing this
 * leaves the repo exactly as it was found. The commit and PR text are asked of
 * the agent *here*, and the confirmed values are handed to Ship — so pressing
 * the button costs one git commit, one push and one `gh pr create`, with no
 * model call in between.
 */
export function ShipModal({
  root,
  rootLabel,
  preview,
  onRefresh,
  onClose,
  onShipped,
  onRemoveWorktree,
  onMarkDone
}: ShipModalProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [subject, setSubject] = useState(preview.subject)
  const [body, setBody] = useState(preview.body)
  const [prTitle, setPrTitle] = useState(preview.prTitle)

  const ship = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await window.api.gitShip({
      root,
      message: { subject: subject.trim(), body: body.trim() },
      pr: { title: prTitle.trim() || subject.trim(), body: preview.prBody }
    })
    if (!res.ok) {
      setBusy(false)
      setError(res.error)
      return
    }
    // The parent unmounts this on success — never touch state after it
    onShipped(res)
  }

  const files = preview.files
  const canShip = !preview.nothingToDo && !busy && (subject.trim().length > 0 || files.length === 0)

  return (
    <ModalShell
      title={
        <span className="ship-title">
          <GitPullRequestArrow size={16} strokeWidth={1.75} aria-hidden="true" />
          {rootLabel}
        </span>
      }
      subtitle={
        (
          <span className="ship-route">
            <code>{preview.willBranch ? 'a new branch' : preview.branch}</code>
            <span aria-hidden="true"> → </span>
            <code>{preview.base}</code>
            {preview.existingPr && <span className="ship-route-note"> · updates the open PR</span>}
            {preview.willBranch && (
              <span className="ship-route-note"> · cut from {preview.branch}, which stays clean</span>
            )}
          </span>
        )
      }
      busy={busy}
      onClose={onClose}
      footer={
        <div className="ship-footer">
          {onRemoveWorktree && (
            <button type="button" className="ship-danger" disabled={busy} onClick={onRemoveWorktree}>
              Remove worktree…
            </button>
          )}
          <div className="ship-footer-right">
            {onMarkDone && (
              <Button intent="secondary" disabled={busy} onClick={onMarkDone}>
                Mark as done
              </Button>
            )}
            <Button disabled={!canShip} onClick={() => void ship()}>
              {busy ? 'Shipping…' : preview.existingPr ? 'Push to PR' : 'Ship'}
            </Button>
          </div>
        </div>
      }
    >
      {error && <div className="ship-error">{error}</div>}

      {preview.nothingToDo && (
        <div className="ship-empty">
          <div className="ship-empty-title">Nothing to ship</div>
          <div className="ship-empty-sub">
            No uncommitted changes, and nothing {preview.base} doesn’t already have.
          </div>
          <Button intent="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      )}

      {!preview.nothingToDo && (
        <>
          {files.length > 0 && (
            <section className="ship-section">
              <h3 className="ship-section-title">
                {files.length} {files.length === 1 ? 'file' : 'files'} to commit
              </h3>
              {/* The list is the review — everything not ignored is going */}
              <ul className="ship-files">
                {files.map((f) => (
                  <li key={f.path} className="ship-file" title={f.path}>
                    <span className={`ship-file-status ship-file-status--${f.status.replace('?', 'q')}`}>
                      {STATUS_WORDS[f.status] ?? f.status}
                    </span>
                    <span className="ship-file-path">{f.path}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {preview.commits.length > 0 && (
            <section className="ship-section">
              <h3 className="ship-section-title">
                {preview.commits.length} already committed, waiting to push
              </h3>
              <ul className="ship-commits">
                {preview.commits.map((c) => (
                  <li key={c} className="ship-commit">
                    {c}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {files.length > 0 && (
            <section className="ship-section">
              <h3 className="ship-section-title">Commit message</h3>
              <input
                type="text"
                className="ship-input"
                aria-label="Commit subject"
                value={subject}
                onChange={(e) => setSubject(e.currentTarget.value)}
              />
              <textarea
                className="ship-textarea"
                aria-label="Commit body"
                rows={3}
                placeholder="Body (optional)"
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
            </section>
          )}

          {!preview.existingPr && (
            <section className="ship-section">
              <h3 className="ship-section-title">Pull request title</h3>
              <input
                type="text"
                className="ship-input"
                aria-label="Pull request title"
                value={prTitle}
                onChange={(e) => setPrTitle(e.currentTarget.value)}
              />
            </section>
          )}
        </>
      )}
    </ModalShell>
  )
}
