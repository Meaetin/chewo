import { describe, expect, it } from 'vitest'
import {
  MAX_TASKS,
  applyTaskResult,
  isBlocked,
  isPlanTool,
  parseTaskResult,
  taskProgress,
  type AgentTask
} from '../src/shared/tool-tasks'

/**
 * Every payload below was captured from Claude Code 2.1.221 on 2026-08-07 —
 * `toolUseResult` for each of the three plan tools, verbatim.
 */
const CREATED = { task: { id: '1', subject: 'alpha' } }
const UPDATED = {
  success: true,
  taskId: '1',
  updatedFields: ['status'],
  statusChange: { from: 'pending', to: 'in_progress' }
}
const DELETED = {
  success: true,
  taskId: '2',
  updatedFields: ['deleted'],
  statusChange: { from: 'pending', to: 'deleted' }
}
/** An owner or a blockedBy edge is named but never valued by the result. */
const OWNED = { success: true, taskId: '1', updatedFields: ['owner'] }
const BLOCKED = { success: true, taskId: '2', updatedFields: ['blockedBy'] }
const LISTED = {
  tasks: [
    { id: '1', subject: 'alpha', status: 'in_progress', owner: 'scout', blockedBy: [] },
    { id: '2', subject: 'beta', status: 'pending', blockedBy: ['1'] }
  ]
}

const build = (): AgentTask[] => {
  let tasks: AgentTask[] = []
  tasks = applyTaskResult(tasks, parseTaskResult(CREATED)!, {
    subject: 'alpha',
    activeForm: 'Doing alpha'
  })
  tasks = applyTaskResult(tasks, parseTaskResult({ task: { id: '2', subject: 'beta' } })!, {
    subject: 'beta'
  })
  return tasks
}

describe('parseTaskResult', () => {
  it('reads a create, an update, a delete and a list', () => {
    expect(parseTaskResult(CREATED)).toEqual({ kind: 'created', id: '1', subject: 'alpha' })
    expect(parseTaskResult(UPDATED)).toEqual({ kind: 'updated', id: '1', status: 'in_progress' })
    expect(parseTaskResult(DELETED)).toEqual({ kind: 'updated', id: '2', deleted: true })
    expect(parseTaskResult(LISTED)).toEqual({
      kind: 'listed',
      tasks: [
        { id: '1', subject: 'alpha', status: 'in_progress', owner: 'scout' },
        { id: '2', subject: 'beta', status: 'pending', blockedBy: ['1'] }
      ]
    })
  })

  it('reads an update that changed something other than status', () => {
    expect(parseTaskResult(OWNED)).toEqual({ kind: 'updated', id: '1' })
    expect(parseTaskResult(BLOCKED)).toEqual({ kind: 'updated', id: '2' })
  })

  it('returns null for a result that is not about the plan', () => {
    expect(parseTaskResult(null)).toBeNull()
    expect(parseTaskResult('done')).toBeNull()
    expect(parseTaskResult({ structuredPatch: [] })).toBeNull()
    expect(parseTaskResult({ type: 'text', file: {} })).toBeNull()
  })

  it('treats an emptied plan as a real state', () => {
    expect(parseTaskResult({ tasks: [] })).toEqual({ kind: 'listed', tasks: [] })
  })

  it('skips a malformed row without discarding the list around it', () => {
    const result = parseTaskResult({
      tasks: [{ id: '1', subject: 'ok', status: 'pending' }, { id: '2' }]
    })
    expect(result).toEqual({ kind: 'listed', tasks: [{ id: '1', subject: 'ok', status: 'pending' }] })
  })
})

describe('applyTaskResult', () => {
  it('appends a created task as pending, taking activeForm off the input', () => {
    expect(build()).toEqual([
      { id: '1', subject: 'alpha', status: 'pending', activeForm: 'Doing alpha' },
      { id: '2', subject: 'beta', status: 'pending' }
    ])
  })

  it('moves a task on a status change', () => {
    const tasks = applyTaskResult(build(), parseTaskResult(UPDATED)!, { taskId: '1' })
    expect(tasks[0].status).toBe('in_progress')
    expect(tasks[1].status).toBe('pending')
  })

  it('takes the owner from the input, since the result only names the field', () => {
    const tasks = applyTaskResult(build(), parseTaskResult(OWNED)!, { taskId: '1', owner: 'scout' })
    expect(tasks[0].owner).toBe('scout')
  })

  it('merges blockedBy edges from the input rather than replacing them', () => {
    let tasks = applyTaskResult(build(), parseTaskResult(BLOCKED)!, {
      taskId: '2',
      addBlockedBy: ['1']
    })
    tasks = applyTaskResult(tasks, parseTaskResult(BLOCKED)!, { taskId: '2', addBlockedBy: ['1'] })
    expect(tasks[1].blockedBy).toEqual(['1'])
  })

  it('removes a deleted task rather than leaving a tombstone', () => {
    const tasks = applyTaskResult(build(), parseTaskResult(DELETED)!, { taskId: '2' })
    expect(tasks.map((t) => t.id)).toEqual(['1'])
  })

  it('ignores an update for a task it never saw created', () => {
    const before = build()
    const after = applyTaskResult(before, { kind: 'updated', id: '99', status: 'completed' }, {})
    expect(after).toBe(before)
  })

  it('reconciles against a list, keeping the activeForm the list does not echo', () => {
    const tasks = applyTaskResult(build(), parseTaskResult(LISTED)!, {})
    expect(tasks).toEqual([
      {
        id: '1',
        subject: 'alpha',
        status: 'in_progress',
        owner: 'scout',
        activeForm: 'Doing alpha'
      },
      { id: '2', subject: 'beta', status: 'pending', blockedBy: ['1'] }
    ])
  })

  it('does not re-add a task that was already created', () => {
    const before = build()
    const after = applyTaskResult(before, parseTaskResult(CREATED)!, {})
    expect(after).toBe(before)
  })

  it('caps a runaway plan', () => {
    let tasks: AgentTask[] = []
    for (let i = 0; i < MAX_TASKS + 10; i++) {
      tasks = applyTaskResult(tasks, { kind: 'created', id: String(i), subject: `t${i}` }, {})
    }
    expect(tasks).toHaveLength(MAX_TASKS)
  })
})

describe('taskProgress', () => {
  it('counts what is done and names the running row by its activeForm', () => {
    const tasks = applyTaskResult(build(), parseTaskResult(UPDATED)!, {})
    expect(taskProgress(tasks)).toEqual({ done: 0, total: 2, running: 'Doing alpha' })
  })

  it('falls back to the subject when there is no activeForm', () => {
    const tasks = applyTaskResult(build(), { kind: 'updated', id: '2', status: 'in_progress' }, {})
    expect(taskProgress(tasks).running).toBe('beta')
  })
})

describe('isBlocked', () => {
  const tasks: AgentTask[] = [
    { id: '1', subject: 'alpha', status: 'pending' },
    { id: '2', subject: 'beta', status: 'pending', blockedBy: ['1'] },
    { id: '3', subject: 'gamma', status: 'pending', blockedBy: ['9'] }
  ]

  it('blocks while the dependency is open and clears once it completes', () => {
    expect(isBlocked(tasks[1], tasks)).toBe(true)
    const done = [{ ...tasks[0], status: 'completed' as const }, tasks[1]]
    expect(isBlocked(done[1], done)).toBe(false)
  })

  it('does not block on a dependency that is not in the list', () => {
    expect(isBlocked(tasks[2], tasks)).toBe(false)
  })
})

describe('isPlanTool', () => {
  it('claims only the three tools the panel renders', () => {
    expect(['TaskCreate', 'TaskUpdate', 'TaskList'].every(isPlanTool)).toBe(true)
  })

  it('leaves the subagent tools alone — Task is the launcher, not a todo', () => {
    for (const name of ['Task', 'TaskGet', 'TaskOutput', 'TaskStop', 'Read'])
      expect(isPlanTool(name)).toBe(false)
  })
})
