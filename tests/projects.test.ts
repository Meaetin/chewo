import { describe, expect, test } from 'vitest'
import {
  assignProject,
  matchSessionToPane,
  sessionInProject,
  type Project,
  type UnboundPane
} from '../src/shared/projects'
import type { SessionMeta } from '../src/shared/adapter/types'

const meta = (overrides: Partial<SessionMeta>): SessionMeta => ({
  id: 'x',
  source: 'claude',
  title: 't',
  project: null,
  createdAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:00:00.000Z',
  filePath: '/f',
  messageCount: 1,
  preview: '',
  ...overrides
})

const project = (id: string, path: string): Project => ({ id, name: id, path, terminals: [] })

describe('sessionInProject', () => {
  test('matches exact path and subdirectories, with trailing-slash tolerance', () => {
    expect(sessionInProject('/Users/m/dev/app', '/Users/m/dev/app')).toBe(true)
    expect(sessionInProject('/Users/m/dev/app/sub', '/Users/m/dev/app/')).toBe(true)
    expect(sessionInProject('/Users/m/dev/app-other', '/Users/m/dev/app')).toBe(false)
    expect(sessionInProject(null, '/Users/m/dev/app')).toBe(false)
  })
})

describe('assignProject', () => {
  test('longest matching path wins for nested projects', () => {
    const parent = project('parent', '/Users/m/dev/app')
    const nested = project('nested', '/Users/m/dev/app/packages/x')
    const s = meta({ project: '/Users/m/dev/app/packages/x/src' })
    expect(assignProject(s, [parent, nested])?.id).toBe('nested')
    expect(assignProject(meta({ project: '/Users/m/dev/app' }), [parent, nested])?.id).toBe('parent')
    expect(assignProject(meta({ project: '/elsewhere' }), [parent, nested])).toBeNull()
  })
})

describe('matchSessionToPane', () => {
  const base = Date.parse('2026-07-16T10:00:00.000Z')
  const pane = (overrides: Partial<UnboundPane>): UnboundPane => ({
    termId: 1,
    source: 'claude',
    cwd: '/Users/m/dev/app',
    spawnedAtMs: base - 5000,
    ...overrides
  })

  test('binds by source + cwd + created-after-spawn', () => {
    const s = meta({ project: '/Users/m/dev/app' })
    expect(matchSessionToPane([pane({})], s)?.termId).toBe(1)
    // wrong source
    expect(matchSessionToPane([pane({ source: 'codex' })], s)).toBeNull()
    // wrong cwd
    expect(matchSessionToPane([pane({ cwd: '/other' })], s)).toBeNull()
    // session predates the pane beyond clock slop → not ours
    const old = meta({ project: '/Users/m/dev/app', createdAt: '2026-07-16T09:00:00.000Z' })
    expect(matchSessionToPane([pane({})], old)).toBeNull()
  })

  test('oldest matching pane wins when two fresh panes share a cwd', () => {
    const older = pane({ termId: 1, spawnedAtMs: base - 8000 })
    const newer = pane({ termId: 2, spawnedAtMs: base - 2000 })
    const s = meta({ project: '/Users/m/dev/app' })
    expect(matchSessionToPane([newer, older], s)?.termId).toBe(1)
  })
})
