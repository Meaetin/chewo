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
    <div className="workflow-switcher">
      <button
        className={`workflow-switcher-option ${workflow === 'code' ? 'workflow-switcher-active' : ''}`}
        title="Coding workflow — sessions, terminals, capabilities"
        onClick={() => onSwitch('code')}
      >
        {'</>'} Code
      </button>
      <button
        className={`workflow-switcher-option ${workflow === 'notes' ? 'workflow-switcher-active' : ''}`}
        title="Note-taking workflow — subjects, topics, dictation"
        onClick={() => onSwitch('notes')}
      >
        ✎ Notes
      </button>
    </div>
  )
}
