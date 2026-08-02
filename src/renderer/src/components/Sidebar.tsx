import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitPullRequestArrow,
  Plus,
  Settings,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { SessionMeta, Source } from '../../../shared/adapter/types'
import type { VersionStatus } from '../../../main/app-version'
import { sessionInSection, type Project, type Worktree } from '../../../shared/projects'
import { useWorktreeState } from '../useGitStatus'
import { Badge, Button, Dot, IconButton, Input, Row } from './ui'

interface SidebarProps {
  sessions: SessionMeta[]
  hiddenSessions: SessionMeta[]
  projects: Project[]
  /** Isolated checkouts — their sessions group under the owning project */
  worktrees: Worktree[]
  /** Live terminal count per section (keyed by project id, null = Home) */
  liveCounts: Map<string | null, number>
  /** Sessions that currently have an open terminal */
  liveSessionIds: Set<string>
  selectedProjectId: string | null
  selectedSessionId?: string
  onSelectProject: (id: string | null) => void
  onCreateProject: () => void
  onHideSession: (id: string) => void
  onRestoreSession: (id: string) => void
  onSelect: (session: SessionMeta) => void
  onNewTerminal: (source: 'claude' | 'codex', opts: { isolate: boolean; task?: string }) => void
  /** undefined = no project selected → button disabled */
  onNewIsolated?: () => void
  /** Worktrees with a live pane open — their row shows the live dot */
  liveWorktreeIds: Set<string>
  /** Focus/resume a branch; false = nothing to resume, ask for an agent instead */
  onOpenWorktree: (wt: Worktree, source?: Source) => boolean
  /** Open the Ship review for this branch */
  onShipWorktree: (wt: Worktree) => void
  /** Spent branches are the only ones offering this — it deletes the checkout */
  onRemoveWorktree: (wt: Worktree) => void
  /** Undo a hand-marked "done" — never offered for a branch git itself calls spent */
  onReopenWorktree: (wt: Worktree) => void
  /** null = Home's settings */
  onOpenSettings: (id: string | null) => void
  onOpenCapabilities: () => void
}

const INITIAL_VISIBLE = 5
const SHOW_MORE_STEP = 15

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
 * The quiet unified create control — caret opens the agent menu (design/06).
 *
 * Also where a session's checkout is decided, because this is the moment you
 * know whether you need one. A project session gets **its own worktree** by
 * default: Ship stages the whole tree, so a session sharing the main checkout
 * with other live agents would sweep their work into its PR. The escape hatch
 * matters for one real case — a fresh worktree is cut from `origin`, so it
 * cannot see uncommitted work sitting in your main checkout, and "look at what
 * I have open" needs a session that shares it.
 *
 * Codex asks for the task up front where Claude does not: a worktree is named
 * after the task, a chat pane can hand over its first message before sending
 * it, and a pty has no composer to intercept.
 */
function NewSessionButton({
  onNewTerminal,
  canIsolate
}: {
  onNewTerminal: (source: 'claude' | 'codex', opts: { isolate: boolean; task?: string }) => void
  /** False in Home — there is no repo to cut a worktree from */
  canIsolate: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [isolate, setIsolate] = useState(true)
  const [askingTask, setAskingTask] = useState(false)
  const [task, setTask] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const taskRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setAskingTask(false)
    setTask('')
  }

  const isolating = canIsolate && isolate

  const pick = (source: 'claude' | 'codex'): void => {
    // A pty has no composer, so its worktree has nothing to be named after
    // until the task is typed somewhere — here is the only somewhere left
    if (source === 'codex' && isolating) {
      setAskingTask(true)
      requestAnimationFrame(() => taskRef.current?.focus())
      return
    }
    onNewTerminal(source, { isolate: isolating })
    close()
  }

  const startCodex = (): void => {
    if (!task.trim()) return
    onNewTerminal('codex', { isolate: true, task: task.trim() })
    close()
  }

  return (
    <div className="new-session" ref={ref}>
      <Button
        intent="secondary"
        className="new-session__trigger"
        leadingIcon={<Plus size={16} strokeWidth={1.75} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        New session
        <ChevronDown className="new-session__caret" size={14} strokeWidth={1.75} />
      </Button>
      {open && (
        <div className="new-session__menu" role="menu">
          {askingTask ? (
            <div className="new-session__task">
              <label className="new-session__task-label" htmlFor="new-session-task">
                What is this session about?
              </label>
              <input
                ref={taskRef}
                id="new-session-task"
                type="text"
                className="new-session__task-input"
                placeholder="fix the drag regression"
                autoComplete="off"
                value={task}
                onChange={(e) => setTask(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    startCodex()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setAskingTask(false)
                  }
                }}
              />
              <div className="new-session__hint">
                Names its checkout, and starts the session off.
              </div>
            </div>
          ) : (
            <>
              <button className="new-session__item" role="menuitem" onClick={() => pick('claude')}>
                <Badge source="claude" />
                Claude
              </button>
              <button className="new-session__item" role="menuitem" onClick={() => pick('codex')}>
                <Badge source="codex" />
                Codex
              </button>
              {canIsolate && (
                <>
                  <div className="new-session__sep" />
                  <button
                    className="new-session__toggle"
                    role="menuitemcheckbox"
                    aria-checked={isolate}
                    onClick={() => setIsolate((v) => !v)}
                  >
                    <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
                    <span className="new-session__toggle-text">
                      {isolate ? 'Its own checkout' : 'Shares the main checkout'}
                    </span>
                    <span className="new-session__toggle-switch" data-on={isolate} />
                  </button>
                  <div className="new-session__hint">
                    {isolate
                      ? 'Cut from origin, so it starts current — and Ship only ever sees this session’s work.'
                      : 'Sees your uncommitted changes, but Ship here stages every agent’s work at once.'}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SessionRow({
  session,
  selected,
  live,
  showProject,
  onSelect,
  actionIcon,
  actionTitle,
  onAction
}: {
  session: SessionMeta
  selected: boolean
  /** Already running — the row dims and a click focuses that pane rather than
   *  starting a second process on the same conversation */
  live?: boolean
  showProject?: string
  onSelect: (s: SessionMeta) => void
  actionIcon?: React.ReactNode
  actionTitle?: string
  onAction?: (id: string) => void
}): React.JSX.Element {
  const trailing = (
    <>
      {onAction && actionIcon && (
        <IconButton
          label={actionTitle ?? 'Action'}
          dense
          onClick={(e) => {
            e.stopPropagation()
            onAction(session.id)
          }}
        >
          {actionIcon}
        </IconButton>
      )}
    </>
  )

  return (
    <Row
      selected={selected}
      live={live}
      className={live ? 'session-row--running' : undefined}
      leading={<Badge source={session.source} />}
      trailing={trailing}
      title={live ? 'Already open — click to focus it' : undefined}
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
  liveSessionIds: Set<string>
  onSelect: (s: SessionMeta) => void
  onHideSession: (id: string) => void
  emptyText: string
}

/** Latest-5 list with Show more — shared by Home and each project. */
function SessionGroup({
  sessions,
  selectedSessionId,
  liveSessionIds,
  onSelect,
  onHideSession,
  emptyText
}: SessionGroupProps): React.JSX.Element {
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  return (
    <div className="project-sessions">
      {sessions.slice(0, visible).map((s) => (
        <SessionRow
          key={`${s.source}:${s.id}`}
          session={s}
          selected={s.id === selectedSessionId}
          live={liveSessionIds.has(s.id)}
          onSelect={onSelect}
          actionIcon={<X size={14} strokeWidth={1.75} />}
          actionTitle="Hide session (file stays on disk; restore from Hidden below)"
          onAction={onHideSession}
        />
      ))}
      {sessions.length === 0 && <div className="session-list-empty">{emptyText}</div>}
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
 * One isolated checkout of a project. Clicking takes you to whatever is in it
 * — the live pane, the remembered terminal, or the newest session recorded
 * there; a branch with nothing to resume opens the agent menu instead, so a
 * worktree whose pane was closed is never a dead end.
 */
function WorktreeRow({
  worktree,
  projectPath,
  live,
  onOpen,
  onShip,
  onRemove,
  onReopen
}: {
  worktree: Worktree
  projectPath: string
  live: boolean
  onOpen: (wt: Worktree, source?: Source) => boolean
  onShip: (wt: Worktree) => void
  onRemove: (wt: Worktree) => void
  onReopen: (wt: Worktree) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const state = useWorktreeState({
    projectPath,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit
  })
  const dirty = state?.dirty ?? 0
  // Spent: its work already landed, or the branch/checkout is gone. Nothing
  // left to merge and nothing that should be edited — the only way out is to
  // remove it. Unknown state (first poll pending) is never treated as spent.
  const byHand = !!worktree.doneAt
  const spent = byHand || (!!state && (state.merged || state.missing || !state.branchExists))
  const spentReason = byHand
    ? 'Marked done by hand — reopen it with the undo button'
    : !state
      ? ''
      : state.missing
        ? 'This checkout is gone from disk — remove it to clear the entry'
        : !state.branchExists
          ? 'This checkout has no branch — remove it to clear the entry'
          : 'Its work has landed — nothing left to do here'

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
          <>
            {dirty > 0 && (
              <span
                className="worktree-row-dirty"
                title={`${dirty} uncommitted change${dirty === 1 ? '' : 's'} on this branch`}
              >
                {dirty}
              </span>
            )}
            {spent ? (
              <>
                {byHand && (
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
                <IconButton
                  label={`${spentReason} — remove this checkout`}
                  dense
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(worktree)
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </IconButton>
              </>
            ) : (
              worktree.branch && (
                <IconButton
                  label="Review and ship this branch"
                  dense
                  onClick={(e) => {
                    e.stopPropagation()
                    onShip(worktree)
                  }}
                >
                  <GitPullRequestArrow size={14} strokeWidth={1.75} />
                </IconButton>
              )
            )}
          </>
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
          {spent && (
            <span className="worktree-row-tag">
              {byHand ? 'done' : state?.merged ? 'merged' : state?.missing ? 'gone' : 'no branch'}
            </span>
          )}
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

/** Section header row (Home / a project) — chevron + name + live/count + settings. */
function SectionRow({
  name,
  title,
  expanded,
  liveCount,
  sessionCount,
  onToggle,
  onOpenSettings,
  settingsTitle
}: {
  name: string
  title?: string
  expanded: boolean
  liveCount: number
  sessionCount: number
  onToggle: () => void
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
          <IconButton label={settingsTitle} dense onClick={(e) => {
            e.stopPropagation()
            onOpenSettings()
          }}>
            <Settings size={14} strokeWidth={1.75} />
          </IconButton>
        }
        onClick={onToggle}
      >
        <span className="section-row-line">
          <span className="section-row-name">{name}</span>
          {liveCount > 0 && (
            <span className="section-live-count" title="Live terminals in this section">
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
  liveSessionIds,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onCreateProject,
  onHideSession,
  onRestoreSession,
  onSelect,
  onNewTerminal,
  onNewIsolated,
  liveWorktreeIds,
  onOpenWorktree,
  onShipWorktree,
  onRemoveWorktree,
  onReopenWorktree,
  onOpenSettings,
  onOpenCapabilities
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  // Home is a section like any project: selected ⟺ expanded ⟺ its tabs show
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

  const toggleProject = (id: string): void => {
    onSelectProject(selectedProjectId === id ? null : id)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-create-row">
        <NewSessionButton onNewTerminal={onNewTerminal} canIsolate={selectedProjectId !== null} />
        <IconButton
          label={
            onNewIsolated
              ? 'New isolated terminal — agent works on its own branch in a separate worktree'
              : 'Select a project to start an isolated terminal'
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
              live={liveSessionIds.has(s.id)}
              showProject={s.project ?? undefined}
              onSelect={onSelect}
              actionIcon={<X size={14} strokeWidth={1.75} />}
              actionTitle="Hide session"
              onAction={onHideSession}
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
                liveSessionIds={liveSessionIds}
                onSelect={onSelect}
                onHideSession={onHideSession}
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
            return (
              <div key={p.id} className="project-section">
                <SectionRow
                  name={p.name}
                  title={p.path}
                  expanded={expanded}
                  liveCount={liveCounts.get(p.id) ?? 0}
                  sessionCount={projectSessions.length}
                  onToggle={() => toggleProject(p.id)}
                  onOpenSettings={() => onOpenSettings(p.id)}
                  settingsTitle="Project settings — permissions, worktree setup, remove"
                />
                {expanded && projectWorktrees.get(p.id)?.length ? (
                  <div className="worktree-group">
                    <div className="worktree-group-header">Isolated branches</div>
                    {projectWorktrees.get(p.id)?.map((w) => (
                      <WorktreeRow
                        key={w.id}
                        worktree={w}
                        projectPath={p.path}
                        live={liveWorktreeIds.has(w.id)}
                        onOpen={onOpenWorktree}
                        onShip={onShipWorktree}
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
                    liveSessionIds={liveSessionIds}
                    onSelect={onSelect}
                    onHideSession={onHideSession}
                    emptyText="No sessions in this folder yet"
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
