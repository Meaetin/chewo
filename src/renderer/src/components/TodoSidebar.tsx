import { House, Folder } from 'lucide-react'
import { Row } from './ui'
import type { Project } from '../../../shared/projects'

interface TodoSidebarProps {
  projects: Project[]
  /** null = the General board */
  selectedId: string | null
  onSelect: (id: string | null) => void
}

/**
 * Board picker for the todo workflow (SPEC-TODOS §5): General on top, then
 * one board per project — the same sections as the coding sidebar.
 */
export function TodoSidebar({
  projects,
  selectedId,
  onSelect
}: TodoSidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar todo-sidebar">
      <div className="project-rail-header">
        <span>Boards</span>
      </div>
      <div className="session-list">
        <Row
          selected={selectedId === null}
          tone="alt"
          onClick={() => onSelect(null)}
          leading={<House size={14} strokeWidth={1.75} />}
        >
          <span className="todo-scope-name">General</span>
        </Row>
        {projects.map((p) => (
          <Row
            key={p.id}
            selected={selectedId === p.id}
            tone="alt"
            onClick={() => onSelect(p.id)}
            leading={<Folder size={14} strokeWidth={1.75} />}
          >
            <span className="todo-scope-name" title={p.path}>
              {p.name}
            </span>
          </Row>
        ))}
        {projects.length === 0 && (
          <div className="session-list-empty">
            Project boards appear here once you add projects in the Code workflow.
          </div>
        )}
      </div>
    </aside>
  )
}
