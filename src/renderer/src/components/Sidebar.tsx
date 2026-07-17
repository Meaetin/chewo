import { useMemo, useState } from 'react'
import type { SessionMeta } from '../../../shared/adapter/types'
import { sessionInSection, type Project, type Worktree } from '../../../shared/projects'

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
  onDeleteProject: (id: string) => void
  onHideSession: (id: string) => void
  onRestoreSession: (id: string) => void
  onSelect: (session: SessionMeta) => void
  onOpenTranscript: (session: SessionMeta) => void
  onNewTerminal: (source: 'claude' | 'codex') => void
  /** undefined = no project selected → button disabled */
  onNewIsolated?: () => void
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

function SessionRow({
  session,
  selected,
  live,
  showProject,
  onSelect,
  onOpenTranscript,
  actionLabel,
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
  actionLabel?: string
  actionTitle?: string
  onAction?: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`session-item ${selected ? 'session-item-selected' : ''} ${live ? 'session-item-live' : ''}`}
      title={live ? 'Terminal open — click to focus it' : undefined}
      onClick={() => onSelect(session)}
    >
      <div className="session-item-top">
        <span className={`source-badge source-badge-${session.source}`}>
          {session.source === 'claude' ? 'CC' : 'CX'}
        </span>
        {live && <span className="session-live-dot">●</span>}
        <span className="session-item-title">{session.title}</span>
        <span className="session-item-time">{relativeTime(session.updatedAt)}</span>
        {live && onOpenTranscript && (
          <button
            className="session-action-button"
            title="View transcript"
            onClick={(e) => {
              e.stopPropagation()
              onOpenTranscript(session)
            }}
          >
            ≡
          </button>
        )}
        {onAction && (
          <button
            className="session-action-button"
            title={actionTitle}
            onClick={(e) => {
              e.stopPropagation()
              onAction(session.id)
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
      {showProject && <div className="session-item-preview">{showProject}</div>}
    </div>
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
          actionLabel="✕"
          actionTitle="Hide session (file stays on disk; restore from Hidden below)"
          onAction={onHideSession}
        />
      ))}
      {sessions.length === 0 && <div className="session-list-empty">{emptyText}</div>}
      {sessions.length > visible && (
        <button className="show-more-button" onClick={() => setVisible((v) => v + SHOW_MORE_STEP)}>
          Show more ({sessions.length - visible})
        </button>
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
  onDeleteProject,
  onHideSession,
  onRestoreSession,
  onSelect,
  onOpenTranscript,
  onNewTerminal,
  onNewIsolated,
  onOpenCapabilities
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [homeExpanded, setHomeExpanded] = useState(false)
  const [hiddenExpanded, setHiddenExpanded] = useState(false)

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
      <div className="sidebar-actions">
        <button className="new-terminal-button" onClick={() => onNewTerminal('claude')}>
          + Claude
        </button>
        <button className="new-terminal-button" onClick={() => onNewTerminal('codex')}>
          + Codex
        </button>
        <button
          className="worktree-new-button"
          title={
            onNewIsolated
              ? 'New isolated terminal — agent works on its own branch in a separate worktree'
              : 'Select a project to start an isolated terminal'
          }
          disabled={!onNewIsolated}
          onClick={onNewIsolated}
        >
          ⎇
        </button>
        <button
          className="capabilities-button"
          title="Skills, subagents, instructions & MCP across projects"
          onClick={onOpenCapabilities}
        >
          ⛭
        </button>
      </div>

      <input
        className="session-search-input"
        placeholder="Search all sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

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
              actionLabel="✕"
              actionTitle="Hide session"
              onAction={onHideSession}
            />
          ))}
          {searchResults.length === 0 && <div className="session-list-empty">No sessions found</div>}
        </div>
      ) : (
        <div className="session-list">
          <div className="project-section">
            <div
              className={`project-row ${homeExpanded ? 'project-row-selected' : ''}`}
              onClick={() => setHomeExpanded((v) => !v)}
              title={window.api.homeDir}
            >
              <span className="project-row-chevron">{homeExpanded ? '▾' : '▸'}</span>
              <span className="project-row-name">Home</span>
              {(liveCounts.get(null) ?? 0) > 0 && (
                <span className="project-row-live" title="Live terminals in this section">
                  ● {liveCounts.get(null)}
                </span>
              )}
              <span className="project-row-count">{homeSessions.length}</span>
            </div>
            {homeExpanded && (
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
            <button className="project-add-button" onClick={onCreateProject} title="Add a project folder">
              +
            </button>
          </div>

          {projects.map((p) => {
            const expanded = selectedProjectId === p.id
            const projectSessions = sessionsByProject.get(p.id) ?? []
            return (
              <div key={p.id} className="project-section">
                <div
                  className={`project-row ${expanded ? 'project-row-selected' : ''}`}
                  onClick={() => toggleProject(p.id)}
                  title={p.path}
                >
                  <span className="project-row-chevron">{expanded ? '▾' : '▸'}</span>
                  <span className="project-row-name">{p.name}</span>
                  {(liveCounts.get(p.id) ?? 0) > 0 && (
                    <span className="project-row-live" title="Live terminals in this section">
                      ● {liveCounts.get(p.id)}
                    </span>
                  )}
                  <span className="project-row-count">{projectSessions.length}</span>
                  <button
                    className="project-delete-button"
                    title="Remove project (sessions are not deleted)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteProject(p.id)
                    }}
                  >
                    ×
                  </button>
                </div>
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
              <div
                className="project-row"
                onClick={() => setHiddenExpanded((v) => !v)}
                title="Sessions hidden from this app — files are untouched"
              >
                <span className="project-row-chevron">{hiddenExpanded ? '▾' : '▸'}</span>
                <span className="project-row-name">Hidden</span>
                <span className="project-row-count">{hiddenSessions.length}</span>
              </div>
              {hiddenExpanded && (
                <div className="project-sessions">
                  {hiddenSessions.map((s) => (
                    <SessionRow
                      key={`${s.source}:${s.id}`}
                      session={s}
                      selected={false}
                      showProject={s.project ?? undefined}
                      onSelect={onSelect}
                      actionLabel="↩"
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
