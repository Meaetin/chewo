import { describe, expect, test } from 'vitest'
import { buildPtyEnv } from '../src/main/terminals'

describe('buildPtyEnv', () => {
  test('scrubs Claude Code session markers that suppress nested-session persistence', () => {
    const env = buildPtyEnv({
      HOME: '/Users/x',
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_EFFORT: 'high',
      UNRELATED: 'keep'
    })
    expect(env.HOME).toBe('/Users/x')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.UNRELATED).toBe('keep')
    expect(Object.keys(env).some((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_'))).toBe(false)
  })

  test('drops undefined values', () => {
    const env = buildPtyEnv({ A: 'x', B: undefined })
    expect(env).toEqual({ A: 'x' })
  })
})
