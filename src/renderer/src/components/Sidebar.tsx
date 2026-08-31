import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  Eye,
  GitBranch,
  Play,
  Plus,
  Settings,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { SessionMeta, Source } from '../../../shared/adapter/types'
import type { VersionStatus } from '../../../main/app-version'
import type { StaleCheckout } from '../../../main/git'
import type { WorktreeState } from '../../../main/worktrees'
import { sessionInSection, type Project, type Worktree } from '../../../shared/projects'
import {
  livePaneBySession,
  unrepresentedLivePanes,
  type LiveSessionPane
} from '../codingWorkspace'
import { useWorktreeState } from '../useGitStatus'
import { Badge, Button, Dot, IconButton, Input, Row } from './ui'

interface SidebarProps {
  sessions: SessionMeta[]
  hiddenSessions: SessionMeta[]
  projects: Project[]
  /** Isolated checkouts — their sessions group under the owning project */
  worktrees: Worktree[]
  /** Live session count per section (keyed by project id, null = Home). */
  liveCounts: Map<string | null, number>
  /** Live agent panes; auxiliary shell ptys are tracked inside the tools panel */
  livePanes: LiveSessionPane[]
  selectedProjectId: string | null
  selectedSessionId?: string
  selectedPaneId?: number
  onSelectProject: (id: string | null) => void
  onCreateProject: () => void
  onHideSession: (id: string) => void
  onRestoreSession: (id: string) => void
  onSelect: (session: SessionMeta) => void
  onSelectLive: (paneId: number) => void
  onCloseLive: (paneId: number) => void
  onNewTerminal: () => void
  /** undefined = no project selected → button disabled */
  onNewIsolated?: () => void
  /** Worktrees with a live pane open — their row shows the live dot */
  liveWorktreeIds: Set<string>
  /** Focus/resume a branch; false = nothing to resume, ask for an agent instead */
  onOpenWorktree: (wt: Worktree, source?: Source) => boolean
  /** Spent branches are the only ones offering this — it deletes the checkout */
  onRemoveWorktree: (wt: Worktree, state: WorktreeState | null) => void
  /** Undo a hand-marked "done" — never offered for a branch git itself calls spent */
  onReopenWorktree: (wt: Worktree) => void
  /** null = Home's settings */
  onOpenSettings: (id: string | null) => void
  /**
   * Run a project's start command — dev servers, in the focused session's
   * checkout when one is open on this project, otherwise its main checkout.
   * Offered per project because the scope is the project's configured command.
   */
  onRunStart: (projectId: string) => void
  /** The isolated checkout ▷ would use, so the button can say where it runs */
  runTarget: { projectId: string | null; taskName: string } | null
  /** Projects whose main checkout is parked on an already-merged branch */
  staleCheckouts: Map<string, StaleCheckout>
  /** Put a stale checkout back on its default branch */
  onSwitchCheckout: (project: Project, to: StaleCheckout) => void
  onOpenCapabilities: () => void
}

const INITIAL_VISIBLE = 5
const SHOW_MORE_STEP = 15

/**
 * A branch's state boiled down to what a row says about it. Shared, because a
 * branch is listed exactly once — sometimes as its own row, more often as the
 * session row standing in for it — and both must read it the same way.
 *
 * Spent: its work already landed, or the branch/checkout is gone. Unknown
 * state (first poll pending) is never treated as spent.
 */
function worktreeSpent(
  worktree: Worktree,
  state: WorktreeState | null
): { spent: boolean; byHand: boolean; reason: string; tag: string } {
  const byHand = !!worktree.doneAt
  const spent = byHand || (!!state && (state.merged || state.missing || !state.branchExists))
  const reason = byHand
    ? 'Marked done by hand — reopen it with the undo button'
    : !state
      ? ''
      : state.missing
        ? 'This checkout is gone from disk — remove it to clear the entry'
        : !state.branchExists
          ? 'This checkout has no branch — remove it to clear the entry'
          : 'Its work has landed — nothing left to do here'
  const tag = byHand ? 'done' : state?.merged ? 'merged' : state?.missing ? 'gone' : 'no branch'
  return { spent, byHand, reason, tag }
}

function sameWorktreeState(a: WorktreeState | null, b: WorktreeState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.missing === b.missing &&
    a.branchExists === b.branchExists &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.dirty === b.dirty &&
    a.merged === b.merged
  )
}

/**
 * Polls one branch and hands the answer up. Headless because the row showing a
 * branch is not always the branch's own row — a session row stands in for it —
 * and a branch with several sessions would otherwise poll git once per row.
 */
function WorktreeStateProbe({
  worktree,
  projectPath,
  onState
}: {
  worktree: Worktree
  projectPath: string
  onState: (id: string, state: WorktreeState | null) => void
}): null {
  const state = useWorktreeState({
    projectPath,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit
  })
  useEffect(() => {
    onState(worktree.id, state)
  }, [worktree.id, state, onState])
  return null
}

/**
 * The branch's own actions: uncommitted count, undo a hand-marked done, delete
 * the checkout. They ride on whichever row is standing in for the branch.
 */
function WorktreeControls({
  worktree,
  state,
  onRemove,
  onReopen
}: {
  worktree: Worktree
  state: WorktreeState | null
  onRemove: (wt: Worktree, state: WorktreeState | null) => void
  onReopen: (wt: Worktree) => void
}): React.JSX.Element {
  const dirty = state?.dirty ?? 0
  const { spent, byHand, reason } = worktreeSpent(worktree, state)
  return (
    <>
      {dirty > 0 && (
        <span
          className="worktree-row-dirty"
          title={`${dirty} uncommitted change${dirty === 1 ? '' : 's'} on this branch`}
        >
          {dirty}
        </span>
      )}
      {spent && byHand && (
        <IconButton
          label="Not done after all — put this branch back to work"
          dense
          onClick={(e) => {
            e.stopPropagation()
            onReopen(worktree)
          }}
        >
          <Undo2 size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {/* Every branch, not just spent ones: abandoning a task you've changed
          your mind about is the ordinary way one ends. The dialog names what
          gets thrown away; the row is hover-revealed, so this is never a stray
          click. */}
      <IconButton
        label={
          spent
            ? `${reason} — remove this checkout`
            : `Delete ${worktree.branch || worktree.taskName} and its checkout`
        }
        dense
        onClick={(e) => {
          e.stopPropagation()
          onRemove(worktree, state)
        }}
      >
        <Trash2 size={14} strokeWidth={1.75} />
      </IconButton>
    </>
  )
}

function relativeTime(iso: string): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

/**
 * The quiet unified create control — one button, no menu (design/06).
 *
 * It used to open a menu that asked for the agent and the checkout up front.
 * Both questions moved into the pane itself: they are only answerable once you
 * know the task, and the pane is where the task gets typed. This is the only
 * way a session is created — selecting a project just navigates to it.
 */
function NewSessionButton({ onNewTerminal }: { onNewTerminal: () => void }): React.JSX.Element {
  return (
    <Button
      intent="secondary"
      className="new-session__trigger"
      leadingIcon={<Plus size={16} strokeWidth={1.75} />}
      onClick={onNewTerminal}
    >
      New session
    </Button>
  )
}

function SessionRow({
  session,
  selected,
  livePane,
  showProject,
  onSelect,
  actionIcon,
  actionTitle,
  onAction,
  onCloseLive
}: {
  session: SessionMeta
  selected: boolean
  /** Already running — the row dims and a click focuses that pane rather than
   *  starting a second process on the same conversation */
  livePane?: LiveSessionPane
  showProject?: string
  onSelect: (s: SessionMeta) => void
  actionIcon?: React.ReactNode
  actionTitle?: string
  onAction?: (id: string) => void
  onCloseLive?: (paneId: number) => void
}): React.JSX.Element {
  const live = !!livePane && !livePane.exited
  const trailing = (
    <>
      {(livePane && onCloseLive) || (onAction && actionIcon) ? (
        <IconButton
          label={
            livePane
              ? live
                ? 'Close running session'
                : 'Close session pane'
              : (actionTitle ?? 'Action')
          }
          dense
          onClick={(e) => {
            e.stopPropagation()
            if (livePane && onCloseLive) onCloseLive(livePane.paneId)
            else onAction?.(session.id)
          }}
        >
          {livePane ? <X size={14} strokeWidth={1.75} /> : actionIcon}
        </IconButton>
      ) : null}
    </>
  )

  return (
    <Row
      selected={selected}
      live={live}
      className={
        livePane ? (live ? 'session-row--running' : 'session-row--exited') : undefined
      }
      leading={<Badge source={session.source} />}
      trailing={trailing}
      title={
        livePane
          ? live
            ? 'Already open — click to focus it'
            : 'Process exited — click to view it'
          : undefined
      }
      onClick={() => onSelect(session)}
    >
      <span className="session-row-line">
        <span className="session-row-title">{session.title}</span>
        <span className="session-row-time">{relativeTime(session.updatedAt)}</span>
      </span>
      {showProject && <span className="session-row-sub">{showProject}</span>}
    </Row>
  )
}

interface SessionGroupProps {
  sessions: SessionMeta[]
  selectedSessionId?: string
  livePanes: LiveSessionPane[]
  projectId: string | null
  selectedPaneId?: number
  onSelect: (s: SessionMeta) => void
  onHideSession: (id: string) => void
  onSelectLive: (paneId: number) => void
  onCloseLive: (paneId: number) => void
  emptyText: string
  /** Branches the panes here run in — a pane row stands in for its branch */
  worktreeById?: Map<string, Worktree>
  worktreeStates?: Map<string, WorktreeState | null>
  onRemoveWorktree?: (wt: Worktree, state: WorktreeState | null) => void
  onReopenWorktree?: (wt: Worktree) => void
}

/** Latest-5 list with Show more — shared by Home and each project. */
function SessionGroup({
  sessions,
  selectedSessionId,
  livePanes,
  projectId,
  selectedPaneId,
  onSelect,
  onHideSession,
  onSelectLive,
  onCloseLive,
  emptyText,
  worktreeById,
  worktreeStates,
  onRemoveWorktree,
  onReopenWorktree
}: SessionGroupProps): React.JSX.Element {
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  const transcriptIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions])
  const placeholders = unrepresentedLivePanes(livePanes, transcriptIds, projectId)
  return (
    <div className="project-sessions">
      {placeholders.map((pane) => {
        const worktree = pane.worktreeId ? worktreeById?.get(pane.worktreeId) : undefined
        const branch = worktree
          ? worktreeSpent(worktree, worktreeStates?.get(worktree.id) ?? null)
          : null
        return (
          <Row
            key={`pane:${pane.paneId}`}
            selected={pane.paneId === selectedPaneId}
            live={!pane.exited}
            className={pane.exited ? 'session-row--exited' : 'session-row--running'}
            leading={<Badge source={pane.source} />}
            title={branch?.reason || undefined}
            trailing={
              <>
                {worktree && onRemoveWorktree && onReopenWorktree && (
                  <WorktreeControls
                    worktree={worktree}
                    state={worktreeStates?.get(worktree.id) ?? null}
                    onRemove={onRemoveWorktree}
                    onReopen={onReopenWorktree}
                  />
                )}
                <IconButton
                  label={pane.exited ? 'Close session pane' : 'Close running session'}
                  dense
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseLive(pane.paneId)
                  }}
                >
                  <X size={14} strokeWidth={1.75} />
                </IconButton>
              </>
            }
            onClick={() => onSelectLive(pane.paneId)}
          >
            <span className="session-row-line">
              <span className="session-row-title">{pane.title}</span>
              {branch?.spent && <span className="worktree-row-tag">{branch.tag}</span>}
              {pane.pending && <span className="session-row-time">new</span>}
            </span>
            {pane.worktreeLabel && <span className="session-row-sub">{pane.worktreeLabel}</span>}
          </Row>
        )
      })}
      {sessions.slice(0, visible).map((s) => (
        <SessionRow
          key={`${s.source}:${s.id}`}
          session={s}
          selected={s.id === selectedSessionId}
          livePane={livePaneBySession(livePanes, s.id)}
          onSelect={onSelect}
          actionIcon={<Eye size={14} strokeWidth={1.75} />}
          actionTitle="Hide session (file stays on disk; restore from Hidden below)"
          onAction={onHideSession}
          onCloseLive={onCloseLive}
        />
      ))}
      {sessions.length === 0 && placeholders.length === 0 && (
        <div className="session-list-empty">{emptyText}</div>
      )}
      {sessions.length > visible && (
        <Button
          intent="ghost"
          size="compact"
          className="show-more-button"
          onClick={() => setVisible((v) => v + SHOW_MORE_STEP)}
        >
          Show more ({sessions.length - visible})
        </Button>
      )}
    </div>
  )
}

/**
 * One isolated checkout of a project, shown only while no session row is
 * already standing in for it — a branch is listed once. Clicking takes you to
 * whatever is in it
 * — the live pane, the remembered terminal, or the newest session recorded
 * there; a branch with nothing to resume opens the agent menu instead, so a
 * worktree whose pane was closed is never a dead end.
 *
 * No Ship button here: a worktree row can represent several sessions. Clicking
 * it focuses a pane whose header owns checkout actions.
 */
function WorktreeRow({
  worktree,
  state,
  live,
  onOpen,
  onRemove,
  onReopen
}: {
  worktree: Worktree
  state: WorktreeState | null
  live: boolean
  onOpen: (wt: Worktree, source?: Source) => boolean
  onRemove: (wt: Worktree, state: WorktreeState | null) => void
  onReopen: (wt: Worktree) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Nothing left to merge and nothing that should be edited — the only way out
  // of a spent branch is to remove it.
  const { spent, reason: spentReason, tag } = worktreeSpent(worktree, state)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const pick = (source: Source): void => {
    onOpen(worktree, source)
    setMenu(false)
  }

  return (
    <div className={`worktree-row${spent ? ' worktree-row--spent' : ''}`} ref={ref} title={spentReason}>
      <Row
        live={live}
        density="compact"
        // Row paints the live dot itself — the glyph is the resting state only
        leading={
          live ? undefined : <GitBranch className="worktree-row-glyph" size={14} strokeWidth={1.75} />
        }
        trailing={
          <WorktreeControls
            worktree={worktree}
            state={state}
            onRemove={onRemove}
            onReopen={onReopen}
          />
        }
        onClick={
          spent
            ? undefined
            : () => {
                if (!onOpen(worktree)) setMenu(true)
              }
        }
      >
        <span className="session-row-line">
          {/* The task name is just this branch without its prefix — one is enough */}
          <span className="session-row-title">{worktree.branch || worktree.taskName}</span>
          {spent && <span className="worktree-row-tag">{tag}</span>}
        </span>
      </Row>
      {menu && (
        <div className="new-session__menu worktree-row__menu" role="menu">
          <button className="new-session__item" role="menuitem" onClick={() => pick('claude')}>
            <Badge source="claude" />
            Claude
          </button>
          <button className="new-session__item" role="menuitem" onClick={() => pick('codex')}>
            <Badge source="codex" />
            Codex
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The project's own checkout is parked on a branch whose work has all been sent.
 *
 * Worth a row of its own because the state is otherwise invisible and it
 * silently changes where work starts: every session that opts out of isolation
 * opens in this checkout, so it inherits the stale branch, and the composer's
 * first row names it in a way that reads like a deliberate choice. Ship parks
 * it there on purpose (so a follow-up ship adds to the same PR), and a hand
 * switch or an agent working in a terminal reaches the same place — so this
 * reports the state, not the cause. `newAgent` tidies it automatically; this
 * row is for whenever that declines, and for the checkout you are looking at
 * rather than the one you are starting a session in.
 *
 * Offered, never applied: `staleCheckout` already refused to report a dirty
 * checkout, but nothing here assumes that is still true a click later — the
 * switch is a plain `git switch` and git's refusal is the guard.
 */
function StaleCheckoutRow({
  project,
  stale,
  onSwitch
}: {
  project: Project
  stale: StaleCheckout
  onSwitch: (project: Project, to: StaleCheckout) => void
}): React.JSX.Element {
  return (
    <div className="stale-checkout">
      <span className="stale-checkout__text">
        This checkout is on <strong>{stale.branch}</strong>, which is already{' '}
        {stale.reason === 'merged' ? 'merged' : 'pushed'}. New sessions that stay here start on it.
      </span>
      <Button
        intent="ghost"
        size="compact"
        className="stale-checkout__action"
        onClick={() => onSwitch(project, stale)}
      >
        Switch to {stale.target}
      </Button>
    </div>
  )
}

/** Section header row (Home / a project) — chevron + name + live/count + run/settings. */
function SectionRow({
  name,
  title,
  expanded,
  liveCount,
  sessionCount,
  onToggle,
  onRunStart,
  runTitle,
  onOpenSettings,
  settingsTitle
}: {
  name: string
  title?: string
  expanded: boolean
  liveCount: number
  sessionCount: number
  onToggle: () => void
  /** Absent for Home — a start command is a project's, not a folder's */
  onRunStart?: () => void
  runTitle?: string
  onOpenSettings: () => void
  settingsTitle: string
}): React.JSX.Element {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div title={title}>
      <Row
        selected={expanded}
        tone="alt"
        leading={<Chevron className="section-chevron" size={14} strokeWidth={1.75} />}
        trailing={
          <span className="section-row-actions">
            {onRunStart && (
              <IconButton
                label={runTitle ?? 'Run start command'}
                dense
                onClick={(e) => {
                  e.stopPropagation()
                  onRunStart()
                }}
              >
                <Play size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            <IconButton label={settingsTitle} dense onClick={(e) => {
              e.stopPropagation()
              onOpenSettings()
            }}>
              <Settings size={14} strokeWidth={1.75} />
            </IconButton>
          </span>
        }
        onClick={onToggle}
      >
        <span className="section-row-line">
          <span className="section-row-name">{name}</span>
          {liveCount > 0 && (
            <span className="section-live-count" title="Live sessions in this section">
              <Dot tone="live" />
              {liveCount}
            </span>
          )}
          <span className="section-row-count">{sessionCount}</span>
        </span>
      </Row>
    </div>
  )
}

/**
 * Installed-build freshness (main/app-version.ts): quiet when the running app
 * matches the repo's HEAD, a CTA when commits have landed since it was built.
 * Renders nothing in dev — dev always runs current source.
 */
function VersionFooter(): React.JSX.Element | null {
  const [status, setStatus] = useState<VersionStatus | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.versionGet().then((s) => {
      if (alive && s) setStatus(s)
    })
    const off = window.api.onVersionStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!status) return null
  return (
    <div className="version-footer">
      {status.kind === 'current' && (
        <span className="version-footer-current">Newest version installed</span>
      )}
      {status.kind === 'behind' && (
        <>
          <span className="version-footer-behind">
            New version available
            {status.commits > 1 ? ` · ${status.commits} commits` : ''}
          </span>
          <button
            className="btn btn--primary btn--compact version-footer-update"
            onClick={() => window.api.versionUpdate()}
          >
            Update
          </button>
        </>
      )}
      {status.kind === 'updating' && (
        <span className="version-footer-updating">Updating — rebuilding app…</span>
      )}
      {status.kind === 'update-failed' && (
        <>
          <span className="version-footer-failed" title={status.message}>
            Update failed
          </span>
          <button
            className="btn btn--secondary btn--compact version-footer-update"
            onClick={() => window.api.versionUpdate()}
          >
            Retry
          </button>
        </>
      )}
    </div>
  )
}

export function Sidebar({
  sessions,
  hiddenSessions,
  projects,
  worktrees,
  liveCounts,
  livePanes,
  selectedProjectId,
  selectedSessionId,
  selectedPaneId,
  onSelectProject,
  onCreateProject,
  onHideSession,
  onRestoreSession,
  onSelect,
  onSelectLive,
  onCloseLive,
  onNewTerminal,
  onNewIsolated,
  liveWorktreeIds,
  onOpenWorktree,
  onRemoveWorktree,
  onReopenWorktree,
  onOpenSettings,
  onRunStart,
  runTarget,
  staleCheckouts,
  onSwitchCheckout,
  onOpenCapabilities
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  // Home is a section like any project: selected means expanded.
  const homeSelected = selectedProjectId === null

  const searching = query.trim().length > 0

  // Global search — the escape hatch for sessions outside any project.
  // Hidden sessions are already filtered out upstream.
  const searchResults = useMemo(() => {
    if (!searching) return []
    const q = query.toLowerCase()
    return sessions
      .filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          (s.project ?? '').toLowerCase().includes(q)
      )
      .slice(0, 50)
  }, [sessions, query, searching])

  const homeSessions = useMemo(
    () => sessions.filter((s) => s.project === window.api.homeDir),
    [sessions]
  )

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionMeta[]>()
    for (const p of projects) {
      map.set(
        p.id,
        sessions.filter((s) => sessionInSection(s.project, p, worktrees))
      )
    }
    return map
  }, [sessions, projects, worktrees])

  const projectWorktrees = useMemo(() => {
    const map = new Map<string, Worktree[]>()
    for (const w of worktrees) {
      const list = map.get(w.projectId)
      if (list) list.push(w)
      else map.set(w.projectId, [w])
    }
    for (const list of map.values()) list.sort((a, b) => a.taskName.localeCompare(b.taskName))
    return map
  }, [worktrees])

  const worktreeById = useMemo(() => new Map(worktrees.map((w) => [w.id, w])), [worktrees])

  const [worktreeStates, setWorktreeStates] = useState<Map<string, WorktreeState | null>>(
    () => new Map()
  )
  const recordWorktreeState = useCallback((id: string, state: WorktreeState | null): void => {
    setWorktreeStates((prev) => {
      if (prev.has(id) && sameWorktreeState(prev.get(id) ?? null, state)) return prev
      const next = new Map(prev)
      next.set(id, state)
      return next
    })
  }, [])

  /**
   * Branches a pane row is already showing — they get no row of their own, so
   * one branch is one row. A session's own transcript can never do this job:
   * every worktree lives under ~/.chewo, which App filters out of the sidebar
   * (its notes and todo runs write session files there too), so a branch with
   * no pane open on it has nothing but its own row to be reached by.
   */
  const panedWorktreeIds = (project: Project): Set<string> => {
    const ids = new Set<string>()
    for (const pane of livePanes)
      if (pane.projectId === project.id && pane.worktreeId) ids.add(pane.worktreeId)
    return ids
  }

  const toggleProject = (id: string): void => {
    onSelectProject(selectedProjectId === id ? null : id)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-create-row">
        <NewSessionButton onNewTerminal={onNewTerminal} />
        <IconButton
          label={
            onNewIsolated
              ? 'New isolated session — agent works on its own branch in a separate worktree'
              : 'Select a project to start an isolated session'
          }
          dense
          disabled={!onNewIsolated}
          onClick={onNewIsolated}
        >
          <GitBranch size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Skills, subagents, instructions & MCP across projects"
          dense
          onClick={onOpenCapabilities}
        >
          <Blocks size={14} strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="sidebar-search-row">
        <Input
          variant="search"
          placeholder="Search all sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {searching ? (
        <div className="session-list">
          {searchResults.map((s) => (
            <SessionRow
              key={`${s.source}:${s.id}`}
              session={s}
              selected={s.id === selectedSessionId}
              livePane={livePaneBySession(livePanes, s.id)}
              showProject={s.project ?? undefined}
              onSelect={onSelect}
              actionIcon={<Eye size={14} strokeWidth={1.75} />}
              actionTitle="Hide session"
              onAction={onHideSession}
              onCloseLive={onCloseLive}
            />
          ))}
          {searchResults.length === 0 && <div className="session-list-empty">No sessions found</div>}
        </div>
      ) : (
        <div className="session-list">
          <div className="project-section">
            <SectionRow
              name="Home"
              title={window.api.homeDir}
              expanded={homeSelected}
              liveCount={liveCounts.get(null) ?? 0}
              sessionCount={homeSessions.length}
              onToggle={() => onSelectProject(null)}
              onOpenSettings={() => onOpenSettings(null)}
              settingsTitle="Home settings — how agents launch here"
            />
            {homeSelected && (
              <SessionGroup
                sessions={homeSessions}
                selectedSessionId={selectedSessionId}
                livePanes={livePanes}
                projectId={null}
                selectedPaneId={selectedPaneId}
                onSelect={onSelect}
                onHideSession={onHideSession}
                onSelectLive={onSelectLive}
                onCloseLive={onCloseLive}
                emptyText="No sessions started in your home folder"
              />
            )}
          </div>

          <div className="project-rail-header">
            <span>Projects</span>
            <IconButton label="Add a project folder" dense onClick={onCreateProject}>
              <Plus size={14} strokeWidth={1.75} />
            </IconButton>
          </div>

          {projects.map((p) => {
            const expanded = selectedProjectId === p.id
            const projectSessions = sessionsByProject.get(p.id) ?? []
            const branches = projectWorktrees.get(p.id) ?? []
            const paned = panedWorktreeIds(p)
            const ownRow = branches.filter((w) => !paned.has(w.id))
            return (
              <div key={p.id} className="project-section">
                <SectionRow
                  name={p.name}
                  title={p.path}
                  expanded={expanded}
                  liveCount={liveCounts.get(p.id) ?? 0}
                  sessionCount={projectSessions.length}
                  onToggle={() => toggleProject(p.id)}
                  onRunStart={() => onRunStart(p.id)}
                  runTitle={
                    runTarget?.projectId === p.id
                      ? `Run ${p.name}’s start command in ⎇ ${runTarget.taskName} — the focused session’s checkout`
                      : `Run ${p.name}’s start command in its main checkout`
                  }
                  onOpenSettings={() => onOpenSettings(p.id)}
                  settingsTitle="Project settings — permissions, worktree setup, remove"
                />
                {expanded && staleCheckouts.get(p.id) ? (
                  <StaleCheckoutRow
                    project={p}
                    stale={staleCheckouts.get(p.id) as StaleCheckout}
                    onSwitch={onSwitchCheckout}
                  />
                ) : null}
                {expanded &&
                  branches.map((w) => (
                    <WorktreeStateProbe
                      key={`state:${w.id}`}
                      worktree={w}
                      projectPath={p.path}
                      onState={recordWorktreeState}
                    />
                  ))}
                {expanded && ownRow.length ? (
                  <div className="worktree-group">
                    <div className="worktree-group-header">Isolated branches</div>
                    {ownRow.map((w) => (
                      <WorktreeRow
                        key={w.id}
                        worktree={w}
                        state={worktreeStates.get(w.id) ?? null}
                        live={liveWorktreeIds.has(w.id)}
                        onOpen={onOpenWorktree}
                        onRemove={onRemoveWorktree}
                        onReopen={onReopenWorktree}
                      />
                    ))}
                  </div>
                ) : null}
                {expanded && (
                  <SessionGroup
                    sessions={projectSessions}
                    selectedSessionId={selectedSessionId}
                    livePanes={livePanes}
                    projectId={p.id}
                    selectedPaneId={selectedPaneId}
                    onSelect={onSelect}
                    onHideSession={onHideSession}
                    onSelectLive={onSelectLive}
                    onCloseLive={onCloseLive}
                    emptyText="No sessions in this folder yet"
                    worktreeById={worktreeById}
                    worktreeStates={worktreeStates}
                    onRemoveWorktree={onRemoveWorktree}
                    onReopenWorktree={onReopenWorktree}
                  />
                )}
              </div>
            )
          })}

          {projects.length === 0 && (
            <div className="session-list-empty">
              No projects yet — add a folder with “+”, or search above to find any past session.
            </div>
          )}

          {hiddenSessions.length > 0 && (
            <div className="project-section hidden-section">
              <Row
                leading={
                  hiddenExpanded ? (
                    <ChevronDown className="section-chevron" size={14} strokeWidth={1.75} />
                  ) : (
                    <ChevronRight className="section-chevron" size={14} strokeWidth={1.75} />
                  )
                }
                onClick={() => setHiddenExpanded((v) => !v)}
                className="hidden-row"
              >
                <span className="section-row-line">
                  <span className="section-row-name">Hidden</span>
                  <span className="section-row-count">{hiddenSessions.length}</span>
                </span>
              </Row>
              {hiddenExpanded && (
                <div className="project-sessions">
                  {hiddenSessions.map((s) => (
                    <SessionRow
                      key={`${s.source}:${s.id}`}
                      session={s}
                      selected={false}
                      showProject={s.project ?? undefined}
                      onSelect={onSelect}
                      actionIcon={<Undo2 size={14} strokeWidth={1.75} />}
                      actionTitle="Restore session"
                      onAction={onRestoreSession}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <VersionFooter />
    </aside>
  )
}
