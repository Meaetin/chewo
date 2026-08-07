/**
 * The plan an agent keeps for itself — the `TaskCreate` / `TaskUpdate` /
 * `TaskList` family.
 *
 * There is no `TodoWrite` any more (gone by CLI 2.1.221), and the replacement
 * is not a whole-list write: a plan arrives as N separate `TaskCreate` calls
 * and moves by `TaskUpdate`, so no single call ever carries the list. That is
 * why this is folded into `ChatState.tasks` rather than rendered per chip.
 *
 * Every shape below was captured live against 2.1.221 on 2026-08-07:
 *
 *   TaskCreate {subject,description,activeForm?}
 *              → {task:{id,subject}}
 *   TaskUpdate {taskId,status?,owner?,subject?,activeForm?,addBlockedBy?}
 *              → {success,taskId,updatedFields:[…],statusChange?:{from,to}}
 *   TaskList   {}
 *              → {tasks:[{id,subject,status,owner?,blockedBy}]}
 *
 * The load-bearing detail: **`updatedFields` names what changed but never
 * carries the new value** — only `statusChange` does. An owner or a blockedBy
 * edge exists solely on the tool's *input*, so applying a result requires both
 * halves, which is why `applyTaskResult` takes the input too.
 *
 * Renderer-safe: no node imports in this file.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  subject: string
  /** Present continuous, shown while the task runs — the CLI supplies it for
   *  exactly that and `TaskList` does not echo it, so it is preserved by id
   *  across a reconcile rather than re-read from one. */
  activeForm?: string
  status: TaskStatus
  /** An agent name, set once a subagent claims the task */
  owner?: string
  /** Ids that must finish first; `TaskList` reports `[]` for an unblocked task */
  blockedBy?: string[]
}

/** What a `Task*` result says happened, before it is applied to the list. */
export type TaskResult =
  | { kind: 'created'; id: string; subject: string }
  | { kind: 'updated'; id: string; status?: TaskStatus; deleted?: boolean }
  | { kind: 'listed'; tasks: AgentTask[] }

/** A plan longer than this is a runaway; every row is DOM in a live thread. */
export const MAX_TASKS = 60

/**
 * The calls whose chip the panel makes redundant — folding eight `TaskCreate`
 * rows into four task rows is the entire point, so leaving both would be worse
 * than neither.
 *
 * Named explicitly rather than matched on a `Task` prefix: **`Task` itself is
 * the subagent launcher**, and `TaskGet`/`TaskOutput`/`TaskStop` are about a
 * running subagent, not about the plan. Suppressing those would hide real work.
 * An unrecognised task-ish tool keeps its chip, which is the safe direction.
 */
const PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList'])

export const isPlanTool = (name: string): boolean => PLAN_TOOLS.has(name)

const STATUSES = new Set<string>(['pending', 'in_progress', 'completed'])

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const asStatus = (v: unknown): TaskStatus | undefined =>
  typeof v === 'string' && STATUSES.has(v) ? (v as TaskStatus) : undefined

function toTask(value: unknown): AgentTask | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  const id = str(t.id)
  const subject = str(t.subject)
  const status = asStatus(t.status)
  if (!id || !subject || !status) return null
  const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map(str).filter(Boolean) : []
  const owner = str(t.owner)
  return {
    id,
    subject,
    status,
    ...(owner ? { owner } : {}),
    ...(blockedBy.length ? { blockedBy } : {})
  }
}

/**
 * A `tool_use_result` → what it says about the plan, or `null` for a result
 * that is not about tasks at all. Sits at the same seam as `parseToolPatch`,
 * and like it, returning `null` is the common case.
 */
export function parseTaskResult(toolUseResult: unknown): TaskResult | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null
  const r = toolUseResult as Record<string, unknown>

  if (Array.isArray(r.tasks)) {
    const tasks: AgentTask[] = []
    for (const item of r.tasks.slice(0, MAX_TASKS)) {
      const task = toTask(item)
      if (task) tasks.push(task)
    }
    // An emptied plan is a real state — the model deleted its last task — so a
    // `tasks: []` reconciles to nothing rather than being read as "not a list".
    return { kind: 'listed', tasks }
  }

  const created = r.task
  if (created && typeof created === 'object') {
    const t = created as Record<string, unknown>
    const id = str(t.id)
    const subject = str(t.subject)
    if (id && subject) return { kind: 'created', id, subject }
  }

  const id = str(r.taskId)
  if (id) {
    const change = r.statusChange as Record<string, unknown> | undefined
    const to = change && typeof change === 'object' ? str(change.to) : ''
    // `deleted` is a status on the wire but not a state a task rests in: the
    // schema says it removes the task permanently, and the next TaskList
    // confirms it is gone.
    if (to === 'deleted') return { kind: 'updated', id, deleted: true }
    return { kind: 'updated', id, ...(asStatus(to) ? { status: asStatus(to) } : {}) }
  }

  return null
}

/** The fields a `TaskUpdate`/`TaskCreate` carries only on its input. */
function inputFields(input: unknown): Partial<AgentTask> & { addBlockedBy?: string[] } {
  if (!input || typeof input !== 'object') return {}
  const i = input as Record<string, unknown>
  const subject = str(i.subject)
  const activeForm = str(i.activeForm)
  const owner = str(i.owner)
  const addBlockedBy = Array.isArray(i.addBlockedBy)
    ? i.addBlockedBy.map(str).filter(Boolean)
    : undefined
  return {
    ...(subject ? { subject } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(owner ? { owner } : {}),
    ...(addBlockedBy?.length ? { addBlockedBy } : {})
  }
}

/**
 * Fold one result into the plan. Pure; returns the same array when nothing
 * changed, so a re-render is only triggered by a real move.
 *
 * `input` is the originating call's arguments — see the note above on why the
 * result alone is not enough.
 */
export function applyTaskResult(
  tasks: AgentTask[],
  result: TaskResult,
  input: unknown
): AgentTask[] {
  const extra = inputFields(input)

  switch (result.kind) {
    case 'created': {
      if (tasks.some((t) => t.id === result.id)) return tasks
      if (tasks.length >= MAX_TASKS) return tasks
      return [
        ...tasks,
        {
          id: result.id,
          subject: result.subject,
          status: 'pending',
          ...(extra.activeForm ? { activeForm: extra.activeForm } : {})
        }
      ]
    }

    case 'updated': {
      if (result.deleted) {
        const next = tasks.filter((t) => t.id !== result.id)
        return next.length === tasks.length ? tasks : next
      }
      const index = tasks.findIndex((t) => t.id === result.id)
      // A task we never saw created — the pane opened mid-turn, or the plan
      // predates the conversation. Nothing to show it beside, so it is dropped
      // rather than invented; the next TaskList will bring it in whole.
      if (index === -1) return tasks
      const prev = tasks[index]
      const blockedBy = extra.addBlockedBy
        ? [...new Set([...(prev.blockedBy ?? []), ...extra.addBlockedBy])]
        : prev.blockedBy
      const next: AgentTask = {
        ...prev,
        ...(result.status ? { status: result.status } : {}),
        ...(extra.subject ? { subject: extra.subject } : {}),
        ...(extra.activeForm ? { activeForm: extra.activeForm } : {}),
        ...(extra.owner ? { owner: extra.owner } : {}),
        ...(blockedBy?.length ? { blockedBy } : {})
      }
      const out = tasks.slice()
      out[index] = next
      return out
    }

    case 'listed': {
      // Authoritative for everything it reports — but it does not report
      // `activeForm`, so carrying it over by id is what stops the running row
      // falling back to its imperative subject the moment the agent lists.
      const byId = new Map(tasks.map((t) => [t.id, t]))
      return result.tasks.map((t) => {
        const prev = byId.get(t.id)
        return prev?.activeForm ? { ...t, activeForm: prev.activeForm } : t
      })
    }
  }
}

export interface TaskProgress {
  done: number
  total: number
  /** The row being worked on, by its `activeForm` where there is one */
  running?: string
}

/** The one line the collapsed panel shows. */
export function taskProgress(tasks: AgentTask[]): TaskProgress {
  const running = tasks.find((t) => t.status === 'in_progress')
  return {
    done: tasks.filter((t) => t.status === 'completed').length,
    total: tasks.length,
    ...(running ? { running: running.activeForm || running.subject } : {})
  }
}

/** A task cannot start while any id it lists is still open. */
export function isBlocked(task: AgentTask, tasks: AgentTask[]): boolean {
  if (!task.blockedBy?.length) return false
  return task.blockedBy.some((id) => {
    const dep = tasks.find((t) => t.id === id)
    return dep ? dep.status !== 'completed' : false
  })
}
