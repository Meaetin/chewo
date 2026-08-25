import { describe, expect, test } from 'vitest'
import { matchModelId, sessionEffort, sessionModel, type AgentModel } from '../src/shared/agents'

/**
 * What a new session spawns with. The picker's labels and the CLI's argv come
 * from these two functions, so a divergence here is a session running on a
 * model the setup row was not showing.
 */

const CODEX_CATALOG: AgentModel[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }
]

const CLAUDE_CATALOG: AgentModel[] = [
  { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
]

describe('sessionModel', () => {
  test('claude opens on opus — a tier alias, so it never names a dated id', () => {
    expect(sessionModel('claude', undefined, CLAUDE_CATALOG)).toBe('opus')
  })

  test('codex opens on the head of its own catalog, which is priority-ordered', () => {
    expect(sessionModel('codex', undefined, CODEX_CATALOG)).toBe('gpt-5.6-sol')
  })

  test('an empty catalog (discovery failed) still resolves rather than blanking', () => {
    expect(sessionModel('claude', undefined, [])).toBe('opus')
    // Codex has no alias to fall back on, so it hands the CLI nothing and lets
    // the user's own config.toml default win
    expect(sessionModel('codex', undefined, [])).toBe('')
  })

  test('the user’s pick always wins', () => {
    expect(sessionModel('claude', 'haiku', CLAUDE_CATALOG)).toBe('haiku')
    expect(sessionModel('codex', 'gpt-5.5', CODEX_CATALOG)).toBe('gpt-5.5')
  })
})

describe('sessionEffort', () => {
  test('defaults to high on both agents', () => {
    expect(sessionEffort('claude', undefined, CLAUDE_CATALOG[0])).toBe('high')
    expect(sessionEffort('codex', undefined, CODEX_CATALOG[0])).toBe('high')
  })

  test('the user’s pick wins when the model accepts it', () => {
    expect(sessionEffort('codex', 'ultra', CODEX_CATALOG[0])).toBe('ultra')
  })

  test('a level this model does not accept is replaced, never passed through', () => {
    // gpt-5.5 has no 'ultra' — sending it would fail at spawn
    const level = sessionEffort('codex', 'ultra', CODEX_CATALOG[1])
    expect(CODEX_CATALOG[1].efforts).toContain(level)
    expect(level).not.toBe('ultra')
  })

  test('an unknown model falls back to the standard ladder', () => {
    expect(sessionEffort('claude', undefined, undefined)).toBe('high')
  })
})

/**
 * Reading a *running* session's model back off the wire. The picker holds tier
 * aliases because that is what a spawn flag takes; a live session announces
 * the model it resolved to. A session resumed from the sidebar spawns with no
 * model flag at all, so this is the only thing that knows what it is on.
 */
describe('matchModelId', () => {
  test('claude reports a resolved id, the picker holds the alias', () => {
    expect(matchModelId('claude-sonnet-5', CLAUDE_CATALOG)).toBe('sonnet')
    expect(matchModelId('claude-opus-5[1m]', CLAUDE_CATALOG)).toBe('opus')
  })

  test('codex ids are already catalog ids and match outright', () => {
    expect(matchModelId('gpt-5.6-sol', CODEX_CATALOG)).toBe('gpt-5.6-sol')
  })

  test('the longest alias wins, so a narrower id cannot be swallowed', () => {
    const catalog: AgentModel[] = [
      { id: 'opus', label: 'Opus', efforts: ['high'] },
      { id: 'opus-mini', label: 'Opus mini', efforts: ['high'] }
    ]
    expect(matchModelId('claude-opus-mini-5', catalog)).toBe('opus-mini')
  })

  test('nothing recognisable returns empty rather than naming the wrong model', () => {
    expect(matchModelId('some-future-model', CLAUDE_CATALOG)).toBe('')
    expect(matchModelId('', CLAUDE_CATALOG)).toBe('')
  })
})
