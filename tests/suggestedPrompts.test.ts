import { describe, expect, test } from 'vitest'
import { suggestedPrompts } from '../src/renderer/src/suggestedPrompts'
import type { Project, Worktree } from '../src/shared/projects'
import type { SessionMeta } from '../src/shared/adapter/types'

const HOME = '/Users/m'

const project: Project = { id: 'p1', name: 'chewo', path: '/repo/chewo', terminals: [] }

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  taskName: 'fix-upload',
  branch: 'agent/fix-upload',
  path: '/repo/chewo-wt-fix-upload',
  baseBranch: 'main',
  createdAt: '2026-08-01T00:00:00Z'
}

const session = (over: Partial<SessionMeta>): SessionMeta => ({
  id: over.id ?? 'id',
  source: 'claude',
  title: over.title ?? 'a task',
  project: over.project ?? null,
  createdAt: over.createdAt ?? '2026-08-01T00:00:00Z',
  updatedAt: over.updatedAt ?? '2026-08-01T00:00:00Z',
  filePath: '/tmp/session.jsonl',
  messageCount: 1,
  preview: over.title ?? 'a task'
})

describe('suggestedPrompts', () => {
  test('picks up sessions in the project checkout and its worktrees, newest first', () => {
    const sessions = [
      session({ id: 'a', title: 'oldest', project: project.path, updatedAt: '2026-08-01T00:00:00Z' }),
      session({ id: 'b', title: 'from a worktree', project: worktree.path, updatedAt: '2026-08-03T00:00:00Z' }),
      session({ id: 'c', title: 'unrelated repo', project: '/repo/other', updatedAt: '2026-08-04T00:00:00Z' })
    ]
    expect(suggestedPrompts(sessions, project, [worktree], HOME)).toEqual([
      'from a worktree',
      'oldest'
    ])
  })

  test('no project means Home, matched by exact cwd', () => {
    const sessions = [
      session({ id: 'a', title: 'home task', project: HOME }),
      session({ id: 'b', title: 'project task', project: project.path })
    ]
    expect(suggestedPrompts(sessions, undefined, [], HOME)).toEqual(['home task'])
  })

  test('caps at three, newest first', () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session({ id: `${i}`, title: `task ${i}`, project: project.path, updatedAt: `2026-08-0${i + 1}T00:00:00Z` })
    )
    expect(suggestedPrompts(sessions, project, [], HOME)).toEqual(['task 4', 'task 3', 'task 2'])
  })

  test('empty when nothing matches', () => {
    expect(suggestedPrompts([], project, [], HOME)).toEqual([])
  })
})
