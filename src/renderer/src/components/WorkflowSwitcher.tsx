import { Code, PencilLine, SquareKanban } from 'lucide-react'
import type { Workflow } from '../../../shared/projects'

const OPTIONS: Array<{ id: Workflow; label: string; title: string; Icon: typeof Code }> = [
  {
    id: 'code',
    label: 'Code',
    title: 'Coding workflow — sessions, terminals, capabilities',
    Icon: Code
  },
  {
    id: 'notes',
    label: 'Notes',
    title: 'Note-taking workflow — subjects, topics, dictation',
    Icon: PencilLine
  },
  {
    id: 'todo',
    label: 'Todo',
    title: 'Todo workflow — kanban boards per project and General',
    Icon: SquareKanban
  }
]

/**
 * Top-left segmented control switching the whole app between workflows.
 * `rail` stacks it vertically and drops the text for the collapsed sidebar —
 * the `title` stays, so an icon-only option keeps its accessible name.
 */
export function WorkflowSwitcher({
  workflow,
  onSwitch,
  rail = false
}: {
  workflow: Workflow
  onSwitch: (w: Workflow) => void
  rail?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`workflow-switcher${rail ? ' workflow-switcher--rail' : ''}`}
      role="tablist"
      aria-label="Workflow"
      aria-orientation={rail ? 'vertical' : 'horizontal'}
    >
      {OPTIONS.map(({ id, label, title, Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={workflow === id}
          aria-label={rail ? label : undefined}
          className={`workflow-switcher-option ${workflow === id ? 'workflow-switcher-active' : ''}`}
          title={title}
          onClick={() => onSwitch(id)}
        >
          <Icon className="workflow-switcher-icon" size={rail ? 16 : 14} strokeWidth={1.75} />
          {!rail && label}
        </button>
      ))}
    </div>
  )
}
