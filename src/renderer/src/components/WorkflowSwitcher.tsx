import { Code, PencilLine, SquareKanban } from 'lucide-react'
import type { Workflow } from '../../../shared/projects'

/** Top-left segmented control switching the whole app between workflows. */
export function WorkflowSwitcher({
  workflow,
  onSwitch
}: {
  workflow: Workflow
  onSwitch: (w: Workflow) => void
}): React.JSX.Element {
  return (
    <div className="workflow-switcher" role="tablist" aria-label="Workflow">
      <button
        role="tab"
        aria-selected={workflow === 'code'}
        className={`workflow-switcher-option ${workflow === 'code' ? 'workflow-switcher-active' : ''}`}
        title="Coding workflow — sessions, terminals, capabilities"
        onClick={() => onSwitch('code')}
      >
        <Code className="workflow-switcher-icon" size={14} strokeWidth={1.75} />
        Code
      </button>
      <button
        role="tab"
        aria-selected={workflow === 'notes'}
        className={`workflow-switcher-option ${workflow === 'notes' ? 'workflow-switcher-active' : ''}`}
        title="Note-taking workflow — subjects, topics, dictation"
        onClick={() => onSwitch('notes')}
      >
        <PencilLine className="workflow-switcher-icon" size={14} strokeWidth={1.75} />
        Notes
      </button>
      <button
        role="tab"
        aria-selected={workflow === 'todo'}
        className={`workflow-switcher-option ${workflow === 'todo' ? 'workflow-switcher-active' : ''}`}
        title="Todo workflow — kanban boards per project and General"
        onClick={() => onSwitch('todo')}
      >
        <SquareKanban className="workflow-switcher-icon" size={14} strokeWidth={1.75} />
        Todo
      </button>
    </div>
  )
}
