import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, Loader } from 'lucide-react'
import { isBlocked, taskProgress, type AgentTask } from '../../../../shared/tool-tasks'

/**
 * The agent's plan, as one list that updates in place.
 *
 * Not a chat item: `TaskCreate` fires once per task and `TaskUpdate` once per
 * move, so rendering them as chips gave eight rows that said "TaskUpdate" and
 * never showed a plan. This is folded in `reduceChat` instead (see
 * `shared/tool-tasks.ts` for the wire shapes) and the calls that feed it have
 * their own chips suppressed.
 */

/** Past this the list folds by default — a long plan is a header, not a wall. */
const AUTO_COLLAPSE_ABOVE = 8

export function TaskPanel({ tasks }: { tasks: AgentTask[] }): React.JSX.Element | null {
  const [toggled, setToggled] = useState<boolean | null>(null)
  if (tasks.length === 0) return null

  const progress = taskProgress(tasks)
  const open = toggled ?? tasks.length <= AUTO_COLLAPSE_ABOVE
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="chat-tasks">
      <button
        className="chat-tasks-head"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        title={open ? 'Hide the plan' : 'Show the plan'}
      >
        <span className="chat-tasks-chevron">
          {open ? (
            <ChevronDown size={13} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} />
          )}
        </span>
        <span className="chat-tasks-label">Plan</span>
        {/* Collapsed, this line is the whole readout — so it carries what is
            happening now rather than the name of the tool that said so. */}
        {progress.running && <span className="chat-tasks-now">{progress.running}</span>}
        <span className="chat-tasks-count">
          {progress.done} of {progress.total}
        </span>
      </button>
      {/* Progress as a hairline rather than a widget: it reads at a glance and
          costs no height, which is what lets the collapsed panel stay one row. */}
      <div
        className="chat-tasks-bar"
        role="progressbar"
        aria-valuenow={progress.done}
        aria-valuemin={0}
        aria-valuemax={progress.total}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      {open && (
        <ol className="chat-tasks-body">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} tasks={tasks} />
          ))}
        </ol>
      )}
    </div>
  )
}

function TaskRow({ task, tasks }: { task: AgentTask; tasks: AgentTask[] }): React.JSX.Element {
  const blocked = task.status === 'pending' && isBlocked(task, tasks)
  return (
    <li className={`chat-task chat-task--${task.status}${blocked ? ' chat-task--blocked' : ''}`}>
      <span className="chat-task-mark" aria-hidden="true">
        {task.status === 'completed' ? (
          <Check size={12} strokeWidth={2} />
        ) : task.status === 'in_progress' ? (
          <Loader size={12} strokeWidth={2} className="chat-tool-spin" />
        ) : (
          <Circle size={12} strokeWidth={2} />
        )}
      </span>
      {/* `activeForm` is the present-tense phrasing the CLI supplies for a
          running task; every other state reads better as the imperative. */}
      <span className="chat-task-subject">
        {task.status === 'in_progress' ? task.activeForm || task.subject : task.subject}
      </span>
      {task.owner && <span className="chat-task-tag chat-task-tag--owner">{task.owner}</span>}
      {blocked && (
        <span className="chat-task-tag chat-task-tag--blocked">
          blocked by {task.blockedBy?.map((id) => `#${id}`).join(', ')}
        </span>
      )}
    </li>
  )
}
