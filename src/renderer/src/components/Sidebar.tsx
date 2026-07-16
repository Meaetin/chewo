import { useMemo, useState } from 'react'
import type { SessionMeta } from '../../../shared/adapter/types'
import { sessionInProject, type Project } from '../../../shared/projects'

interface SidebarProps {
  sessions: SessionMeta[]
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId?: string
  onSelectProject: (id: string | null) => void
  onCreateProject: () => void
  onDeleteProject: (id: string) => void
  onSelect: (session: SessionMeta) => void
  onNewTerminal: (source: 'claude' | 'codex') => void
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
  showProject,
  onSelect
}: {
  session: SessionMeta
  selected: boolean
  showProject?: string
  onSelect: (s: SessionMeta) => void
}): React.JSX.Element {
  return (
    <div
      className={`session-item ${selected ? 'session-item-selected' : ''}`}
      onClick={() => onSelect(session)}
    >
      <div className="session-item-top">
        <span className={`source-badge source-badge-${session.source}`}>
          {session.source === 'claude' ? 'CC' : 'CX'}
        </span>
        <span className="session-item-title">{session.title}</span>
        <span className="session-item-time">{relativeTime(session.updatedAt)}</span>
      </div>
      {showProject && <div className="session-item-preview">{showProject}</div>}
    </div>
  )
}

export function Sidebar({
  sessions,
  projects,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onSelect,
  onNewTerminal
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})

  const searching = query.trim().length > 0

  // Global search — the escape hatch for sessions outside any project
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

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionMeta[]>()
    for (const p of projects) {
      map.set(
        p.id,
        sessions.filter((s) => sessionInProject(s.project, p.path))
      )
    }
    return map
  }, [sessions, projects])

  const toggleProject = (id: string): void => {
    const next = selectedProjectId === id ? null : id
    onSelectProject(next)
    if (next === null) setVisibleCounts((c) => ({ ...c, [id]: INITIAL_VISIBLE }))
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
              showProject={s.project ?? undefined}
              onSelect={onSelect}
            />
          ))}
          {searchResults.length === 0 && <div className="session-list-empty">No sessions found</div>}
        </div>
      ) : (
        <div className="session-list">
          <div className="project-rail-header">
            <span>Projects</span>
            <button className="project-add-button" onClick={onCreateProject} title="Add a project folder">
              +
            </button>
          </div>

          {projects.map((p) => {
            const expanded = selectedProjectId === p.id
            const projectSessions = sessionsByProject.get(p.id) ?? []
            const visible = visibleCounts[p.id] ?? INITIAL_VISIBLE
            return (
              <div key={p.id} className="project-section">
                <div
                  className={`project-row ${expanded ? 'project-row-selected' : ''}`}
                  onClick={() => toggleProject(p.id)}
                  title={p.path}
                >
                  <span className="project-row-chevron">{expanded ? '▾' : '▸'}</span>
                  <span className="project-row-name">{p.name}</span>
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
                  <div className="project-sessions">
                    {projectSessions.slice(0, visible).map((s) => (
                      <SessionRow
                        key={`${s.source}:${s.id}`}
                        session={s}
                        selected={s.id === selectedSessionId}
                        onSelect={onSelect}
                      />
                    ))}
                    {projectSessions.length === 0 && (
                      <div className="session-list-empty">No sessions in this folder yet</div>
                    )}
                    {projectSessions.length > visible && (
                      <button
                        className="show-more-button"
                        onClick={() =>
                          setVisibleCounts((c) => ({ ...c, [p.id]: visible + SHOW_MORE_STEP }))
                        }
                      >
                        Show more ({projectSessions.length - visible})
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {projects.length === 0 && (
            <div className="session-list-empty">
              No projects yet — add a folder with “+”, or search above to find any past session.
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
