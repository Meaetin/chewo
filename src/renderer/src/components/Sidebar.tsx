import { useMemo, useState } from 'react'
import type { SessionMeta } from '../../../shared/adapter/types'

interface SidebarProps {
  sessions: SessionMeta[]
  selectedId?: string
  onSelect: (session: SessionMeta) => void
  onNewTerminal: (source: 'claude' | 'codex') => void
}

function projectLabel(project: string | null): string {
  if (!project) return 'unknown project'
  const parts = project.split('/')
  return parts[parts.length - 1] || project
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

export function Sidebar({ sessions, selectedId, onSelect, onNewTerminal }: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.toLowerCase()
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.preview.toLowerCase().includes(q) ||
            (s.project ?? '').toLowerCase().includes(q)
        )
      : sessions

    const byProject = new Map<string, SessionMeta[]>()
    for (const s of filtered) {
      const key = projectLabel(s.project)
      const list = byProject.get(key) ?? []
      list.push(s)
      byProject.set(key, list)
    }
    // Groups ordered by their most recent session (input is already sorted desc)
    return [...byProject.entries()]
  }, [sessions, query])

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
        placeholder="Search sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="session-list">
        {groups.map(([project, items]) => (
          <div key={project} className="project-group">
            <div className="project-group-header">{project}</div>
            {items.map((s) => (
              <div
                key={`${s.source}:${s.id}`}
                className={`session-item ${s.id === selectedId ? 'session-item-selected' : ''}`}
                onClick={() => onSelect(s)}
              >
                <div className="session-item-top">
                  <span className={`source-badge source-badge-${s.source}`}>
                    {s.source === 'claude' ? 'CC' : 'CX'}
                  </span>
                  <span className="session-item-title">{s.title}</span>
                  <span className="session-item-time">{relativeTime(s.updatedAt)}</span>
                </div>
                {s.preview && <div className="session-item-preview">{s.preview}</div>}
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="session-list-empty">No sessions found</div>}
      </div>
    </aside>
  )
}
