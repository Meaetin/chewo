import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  GitBranch,
  Plus,
  RefreshCw,
  Search
} from 'lucide-react'
import type { RepoStatus } from '../../../main/git'
import type { BranchInfo, BranchListResult, GitOpResult } from '../../../main/git-ops'
import { Tooltip } from './ui'

interface BranchMenuProps {
  /** Effective repo root for the active session — the worktree path when isolated */
  root: string
  /** Header text — basename of the root, ⎇-prefixed for worktrees */
  rootLabel: string
  /** Live status owned by App; the trigger reads its branch and ahead/behind */
  status: RepoStatus | null
  onToast: (message: string) => void
}

const MENU_GAP = 6
const MENU_WIDTH = 320
const MENU_MAX_HEIGHT = 420

type Busy = 'fetch' | 'pull' | 'push' | 'checkout' | null

/** `agent/fix-thing` → matches on "fix", "agent/fix", "fixthing" */
function matches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return name.toLowerCase().includes(q)
}

function BranchRow({
  branch,
  current,
  disabledReason,
  onPick
}: {
  branch: BranchInfo
  current: boolean
  disabledReason?: string
  onPick: () => void
}): React.JSX.Element {
  const title = disabledReason ?? `${branch.name}${branch.subject ? ` — ${branch.subject}` : ''}`
  return (
    <button
      type="button"
      className={`branch-row ${current ? 'branch-row-current' : ''} ${disabledReason ? 'branch-row-disabled' : ''}`}
      title={title}
      disabled={Boolean(disabledReason)}
      onClick={onPick}
    >
      <span className="branch-row-check">
        {current && <Check size={13} strokeWidth={2.25} aria-hidden="true" />}
      </span>
      <span className="branch-row-name">{branch.name}</span>
      {branch.gone && (
        <span className="branch-row-tag" title="Upstream branch no longer exists on the remote">
          gone
        </span>
      )}
      {disabledReason && <span className="branch-row-tag">in use</span>}
      {(branch.ahead > 0 || branch.behind > 0) && (
        <span className="branch-row-track" title={`${branch.ahead} ahead, ${branch.behind} behind`}>
          {branch.ahead > 0 && `↑${branch.ahead}`}
          {branch.behind > 0 && `↓${branch.behind}`}
        </span>
      )}
    </button>
  )
}

/**
 * Branch control for the active session's checkout: which branch it is on,
 * and the switch. Agents `git checkout -b` behind our back (a PR branch, an
 * isolated task), and until this existed the only way back was a terminal.
 *
 * Every action here runs against `root` — the worktree when the session is
 * isolated, the project otherwise — so it can never move a checkout other
 * than the one the panels are showing. Nothing is forced: a switch that would
 * discard work, or a branch another worktree holds, comes back as git's own
 * refusal rather than something this UI works around.
 */
export function BranchMenu({
  root,
  rootLabel,
  status,
  onToast
}: BranchMenuProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [list, setList] = useState<BranchListResult | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const repo = status?.ok && status.isRepo ? status : null

  const load = useCallback(() => {
    void window.api.gitBranches(root).then(setList)
  }, [root])

  // Branches move under us constantly — every open re-reads rather than caching
  useEffect(() => {
    if (!open) return
    load()
    searchRef.current?.focus()
  }, [open, load])

  useEffect(() => {
    setOpen(false)
  }, [root])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const run = async (kind: Exclude<Busy, null>, op: () => Promise<GitOpResult>): Promise<void> => {
    if (busy) return
    setBusy(kind)
    setError(null)
    const res = await op()
    setBusy(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onToast(res.message)
    if (kind === 'checkout') setOpen(false)
    else load()
  }

  const checkout = (ref: string, create = false): void => {
    void run('checkout', () => window.api.gitCheckout({ root, ref, create }))
  }

  const branches = list?.ok ? list : null
  const current = branches?.current ?? repo?.branch ?? null

  const shownLocal = useMemo(
    () => (branches?.local ?? []).filter((b) => matches(b.name, query)),
    [branches, query]
  )
  const shownRemote = useMemo(
    () =>
      (branches?.remote ?? []).filter(
        (b) =>
          matches(b.name, query) &&
          // A remote ref whose local twin is already listed is the same start
          // point twice; the local row is the one that switches cleanly
          !(branches?.local ?? []).some((l) => l.name === b.name.slice(b.name.indexOf('/') + 1))
      ),
    [branches, query]
  )

  const typed = query.trim()
  const canCreate =
    typed.length > 0 &&
    !/\s/.test(typed) &&
    !(branches?.local ?? []).some((b) => b.name === typed)

  // Nothing to show until status says this root really is a repo — a chip that
  // appears and then vanishes reads as a glitch
  if (!repo) return null

  const dirty = repo.files.length
  const label = repo.branch

  return (
    <>
      <Tooltip label={`Branch — switch, fetch, pull, push in ${rootLabel}`} side="top">
        <button
          ref={triggerRef}
          type="button"
          className={`branch-button ${open ? 'branch-button-open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              setOpen(false)
              return
            }
            const r = triggerRef.current?.getBoundingClientRect()
            if (!r) return
            setRect(r)
            setQuery('')
            setError(null)
            setOpen(true)
          }}
        >
          <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="branch-button-name">{label}</span>
          {repo.upstream && (repo.ahead > 0 || repo.behind > 0) && (
            <span className="branch-button-track">
              {repo.ahead > 0 && `↑${repo.ahead}`}
              {repo.behind > 0 && `↓${repo.behind}`}
            </span>
          )}
          <ChevronDown className="branch-button-chevron" size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </Tooltip>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="branch-menu"
            role="menu"
            style={{
              top: rect.bottom + MENU_GAP,
              left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
              width: MENU_WIDTH,
              maxHeight: Math.min(MENU_MAX_HEIGHT, window.innerHeight - rect.bottom - 24)
            }}
          >
            <div className="branch-menu-head" title={root}>
              <span className="branch-menu-root">{rootLabel}</span>
              {repo.upstream ? (
                <span className="branch-menu-upstream">{repo.upstream}</span>
              ) : (
                <span className="branch-menu-upstream">no upstream</span>
              )}
            </div>

            <div className="branch-menu-actions">
              <button
                type="button"
                className="branch-action"
                disabled={busy !== null}
                onClick={() => void run('fetch', () => window.api.gitFetch(root))}
              >
                <RefreshCw
                  className={busy === 'fetch' ? 'branch-action-spin' : ''}
                  size={13}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                Fetch
              </button>
              <button
                type="button"
                className="branch-action"
                disabled={busy !== null}
                title="git pull --ff-only — never rebases or merges under a running agent"
                onClick={() => void run('pull', () => window.api.gitPull(root))}
              >
                <ArrowDownToLine size={13} strokeWidth={1.75} aria-hidden="true" />
                Pull
                {repo.behind > 0 && <span className="branch-action-count">{repo.behind}</span>}
              </button>
              <button
                type="button"
                className="branch-action"
                disabled={busy !== null}
                title={
                  repo.upstream
                    ? 'git push'
                    : 'This branch has no upstream — push publishes it to the remote'
                }
                onClick={() =>
                  void run('push', () =>
                    window.api.gitPush({ root, setUpstream: !repo.upstream })
                  )
                }
              >
                <ArrowUpFromLine size={13} strokeWidth={1.75} aria-hidden="true" />
                {repo.upstream ? 'Push' : 'Publish'}
                {repo.ahead > 0 && <span className="branch-action-count">{repo.ahead}</span>}
              </button>
            </div>

            {error && <div className="branch-menu-error">{error}</div>}

            <div className="branch-menu-search">
              <Search size={13} strokeWidth={1.75} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                className="branch-menu-search-input"
                placeholder="Find or create a branch…"
                aria-label="Find or create a branch"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const first = shownLocal[0] ?? shownRemote[0]
                  if (first && first.name !== current) checkout(first.name)
                  else if (canCreate) checkout(typed, true)
                }}
              />
            </div>

            <div className="branch-menu-list">
              {list === null && <div className="branch-menu-empty">Reading branches…</div>}
              {list?.ok === false && <div className="branch-menu-empty">{list.error}</div>}

              {shownLocal.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  current={b.name === current}
                  // git refuses a branch another worktree holds; say so up front
                  disabledReason={
                    b.worktree && b.name !== current
                      ? `Checked out in another worktree: ${b.worktree}`
                      : undefined
                  }
                  onPick={() => checkout(b.name)}
                />
              ))}

              {shownRemote.length > 0 && (
                <div className="branch-menu-section">Remote — checks out a tracking branch</div>
              )}
              {shownRemote.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  current={false}
                  onPick={() => checkout(b.name)}
                />
              ))}

              {branches && shownLocal.length === 0 && shownRemote.length === 0 && !canCreate && (
                <div className="branch-menu-empty">No matching branches</div>
              )}

              {canCreate && (
                <button type="button" className="branch-row branch-row-create" onClick={() => checkout(typed, true)}>
                  <span className="branch-row-check">
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                  </span>
                  <span className="branch-row-name">
                    Create <strong>{typed}</strong> from {current}
                  </span>
                </button>
              )}

              {branches?.remoteTruncated && (
                <div className="branch-menu-empty">
                  first {branches.remote.length} remote branches — narrow the filter
                </div>
              )}
            </div>

            {dirty > 0 && (
              <div className="branch-menu-foot">
                {dirty} uncommitted {dirty === 1 ? 'change' : 'changes'} — they come with you, and
                git refuses the switch if they would be lost
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
