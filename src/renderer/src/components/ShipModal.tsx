import { useState } from 'react'
import { GitPullRequestArrow } from 'lucide-react'
import type { ShipPreview, ShipSuccess } from '../../../main/git-ship'
import { branchNameFromSubject } from '../../../shared/branch-names'
import { willCutBranch, type ShipRoute } from '../../../shared/ship-route'
import { ModalShell } from './ModalShell'
import { Select, type SelectOption } from './Select'
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

const ROUTES: { route: ShipRoute; title: string; sub: (base: string) => string }[] = [
  { route: 'pr', title: 'Open a pull request', sub: (b) => `reviewed, then merged into ${b}` },
  { route: 'push', title: 'Push straight on', sub: (b) => `commits land on ${b} now` }
]

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
  const [base, setBase] = useState(preview.base)
  /**
   * The PR route is never pre-selected away from. Pushing straight onto the
   * base skips review, which is the thing shipping exists to guarantee — it is
   * offered because a fix to a branch already under review, or an integration
   * branch where a PR per change is noise, are both real; it is not a default.
   */
  const [route, setRoute] = useState<ShipRoute>('pr')
  // A branch that exists keeps its name; one about to be cut starts from the
  // commit subject, which a model already wrote from the diff
  const [branch, setBranch] = useState(
    preview.willBranch ? branchNameFromSubject(preview.subject) : preview.branch
  )
  const [commits, setCommits] = useState(preview.commits)

  /**
   * Retargeting pulls in every commit the new base is missing, so the count has
   * to move with the picker — but it is a local `git log`, not another read of
   * the whole change. The commit message describes the working tree and doesn't
   * depend on the base at all, so nothing regenerates and nothing you typed is
   * thrown away.
   */
  const retarget = (next: string): void => {
    setBase(next)
    void window.api.gitShipCompare({ root, base: next }).then((res) => {
      if (res.ok) setCommits(res.commits)
    })
  }

  const ship = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await window.api.gitShip({
      root,
      base,
      route,
      // The push route never puts this branch on the remote, so its name is
      // nobody's business but this checkout's — renaming it would be theatre
      ...(route === 'pr' && { renameBranch: branch.trim() || undefined }),
      message: { subject: subject.trim(), body: body.trim() },
      ...(route === 'pr' && {
        pr: { title: prTitle.trim() || subject.trim(), body: preview.prBody }
      })
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

  // Recomputed here rather than read off the preview: the preview was taken
  // before a route was chosen, and the rule differs between them
  const willBranch = willCutBranch(route, preview.branch, base, preview.repoDefault)

  /**
   * A name is only editable while the branch is still local: once it is pushed
   * the remote holds that name and any PR hangs off it, so renaming would mean
   * deleting a remote branch, which Ship refuses.
   *
   * `willBranch` overrides that, and must — it means HEAD is `main`, which is
   * of course pushed, but nothing is being *renamed*; the field names the
   * branch about to be cut, which is the case where naming matters most.
   *
   * The push route never names anything: the commits go onto the base under
   * its name, and this branch stays local.
   */
  const canName = route === 'pr' && (willBranch || (!preview.pushed && !preview.existingPr))

  /** Straight onto the branch every PR lands in — the one combination worth a warning */
  const bypassesReview = route === 'push' && base === preview.repoDefault

  /**
   * Derived from the subject as it stands, not as it was generated — editing
   * the message and then asking for a name should follow what you wrote. It is
   * offered rather than applied, because a branch that already exists has a
   * name someone may be depending on.
   */
  const suggestion = branchNameFromSubject(subject)

  const baseOptions: SelectOption<string>[] = preview.bases.map((b) => ({
    value: b,
    label: b,
    ...(b === preview.repoDefault && { detail: 'default' })
  }))

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
            <code>
              {route === 'push'
                ? preview.branch
                : branch.trim() || (willBranch ? 'a new branch' : preview.branch)}
            </code>
            <span aria-hidden="true"> → </span>
            <code>{base}</code>
            {route === 'push' && <span className="ship-route-note"> · commits go straight on</span>}
            {route === 'pr' && preview.existingPr && (
              <span className="ship-route-note"> · updates the open PR</span>
            )}
            {willBranch && (
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
              {busy
                ? route === 'push'
                  ? 'Pushing…'
                  : 'Shipping…'
                : route === 'push'
                  ? `Push onto ${base}`
                  : preview.existingPr
                    ? 'Push to PR'
                    : 'Ship'}
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
          <section className="ship-section">
            <h3 className="ship-section-title">Where it goes</h3>
            {/* The question can only be answered once the diff is visible, which
                is why it is asked here and not when the session was created */}
            <div className="ship-routes" role="radiogroup" aria-label="How to ship">
              {ROUTES.map((r) => (
                <button
                  key={r.route}
                  type="button"
                  role="radio"
                  aria-checked={route === r.route}
                  className={`ship-route-chip${route === r.route ? ' ship-route-chip--on' : ''}`}
                  onClick={() => setRoute(r.route)}
                >
                  <span className="ship-route-chip-title">{r.title}</span>
                  <span className="ship-route-chip-sub">{r.sub(base)}</span>
                </button>
              ))}
            </div>
            {bypassesReview && (
              <div className="ship-note ship-note--warn">
                Straight onto <code>{base}</code> — no pull request, so nothing reviews this.
              </div>
            )}
            <div className="ship-route-fields">
              <label className="ship-field" hidden={route === 'push'}>
                <span className="ship-field-label">
                  {willBranch ? 'New branch' : 'From'}
                  {canName && suggestion && suggestion !== branch.trim() && (
                    <button
                      type="button"
                      className="ship-suggest"
                      title={`Name it ${suggestion}, from the commit message`}
                      onClick={() => setBranch(suggestion)}
                    >
                      use {suggestion}
                    </button>
                  )}
                </span>
                {canName ? (
                  <input
                    type="text"
                    className="ship-input"
                    aria-label="Branch name"
                    placeholder={willBranch ? 'named from the commit' : preview.branch}
                    value={branch}
                    onChange={(e) => setBranch(e.currentTarget.value)}
                  />
                ) : (
                  <div className="ship-static" title="Already on the remote — rename it there">
                    {preview.branch}
                  </div>
                )}
              </label>
              <label className="ship-field">
                <span className="ship-field-label">{route === 'push' ? 'Onto' : 'Into'}</span>
                <Select value={base} options={baseOptions} onChange={retarget} />
              </label>
            </div>
            {route === 'pr' && base !== preview.repoDefault && (
              <div className="ship-note">
                Not the default branch — this PR shows everything <code>{base}</code> is missing,
                not just this session&rsquo;s work.
              </div>
            )}
            {route === 'push' && !bypassesReview && (
              <div className="ship-note">
                No pull request is opened. If <code>{base}</code> already has one, these commits
                join it; the result says which.
              </div>
            )}
          </section>

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

          {commits.length > 0 && (
            <section className="ship-section">
              <h3 className="ship-section-title">
                {commits.length} already committed, waiting to push
              </h3>
              <ul className="ship-commits">
                {commits.map((c) => (
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
