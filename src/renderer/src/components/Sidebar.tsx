import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  ScrollText,
  Settings,
  Undo2
} from 'lucide-react'
import type { SessionMeta } from '../../../shared/adapter/types'
import { sessionInSection, type Project, type Worktree } from '../../../shared/projects'
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
  onOpenTranscript: (session: SessionMeta) => void
  onNewTerminal: (source: 'claude' | 'codex') => void
  /** undefined = no project selected → button disabled */
  onNewIsolated?: () => void
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

/** The quiet unified create control — caret opens the agent menu (design/06). */
function NewSessionButton({
  onNewTerminal
}: {
  onNewTerminal: (source: 'claude' | 'codex') => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  const pick = (source: 'claude' | 'codex'): void => {
    onNewTerminal(source)
    setOpen(false)
  }

  return (
    <div className="new-session" ref={ref}>
      <Button
        intent="secondary"
        className="new-session__trigger"
        leadingIcon={<Plus size={16} strokeWidth={1.75} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        New session
        <ChevronDown className="new-session__caret" size={14} strokeWidth={1.75} />
      </Button>
      {open && (
        <div className="new-session__menu" role="menu">
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

function SessionRow({
  session,
  selected,
  live,
  showProject,
  onSelect,
  onOpenTranscript,
  actionIcon,
  actionTitle,
  onAction
}: {
  session: SessionMeta
  selected: boolean
  /** A terminal is open for this session — clicking focuses it */
  live?: boolean
  showProject?: string
  onSelect: (s: SessionMeta) => void
  onOpenTranscript?: (s: SessionMeta) => void
  actionIcon?: React.ReactNode
  actionTitle?: string
  onAction?: (id: string) => void
}): React.JSX.Element {
  const trailing = (
    <>
      {live && onOpenTranscript && (
        <IconButton
          label="View transcript"
          dense
          onClick={(e) => {
            e.stopPropagation()
            onOpenTranscript(session)
          }}
        >
          <ScrollText size={14} strokeWidth={1.75} />
        </IconButton>
      )}
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
      leading={<Badge source={session.source} />}
      trailing={trailing}
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
  onOpenTranscript: (s: SessionMeta) => void
  onHideSession: (id: string) => void
  emptyText: string
}

/** Latest-5 list with Show more — shared by Home and each project. */
function SessionGroup({
  sessions,
  selectedSessionId,
  liveSessionIds,
  onSelect,
  onOpenTranscript,
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
          onOpenTranscript={onOpenTranscript}
          actionIcon={<Undo2 size={14} strokeWidth={1.75} style={{ transform: 'scaleX(-1)' }} />}
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
  onOpenTranscript,
  onNewTerminal,
  onNewIsolated,
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
              onOpenTranscript={onOpenTranscript}
              actionIcon={<Undo2 size={14} strokeWidth={1.75} style={{ transform: 'scaleX(-1)' }} />}
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
                onOpenTranscript={onOpenTranscript}
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
                {expanded && (
                  <SessionGroup
                    sessions={projectSessions}
                    selectedSessionId={selectedSessionId}
                    liveSessionIds={liveSessionIds}
                    onSelect={onSelect}
                    onOpenTranscript={onOpenTranscript}
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
    </aside>
  )
}
