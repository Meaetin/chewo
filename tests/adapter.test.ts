import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { parseClaudeSession } from '../src/shared/adapter/claude'
import { parseCodexSession, parseCodexTitleIndex } from '../src/shared/adapter/codex'

const fixture = (p: string): string => join(__dirname, 'fixtures', p)

describe('claude adapter', () => {
  test('parses a basic session with correct meta', () => {
    const { meta } = parseClaudeSession(fixture('claude/v2.1-basic.jsonl'))
    expect(meta.id).toBe('aaaaaaaa-1111-2222-3333-444444444444')
    expect(meta.source).toBe('claude')
    expect(meta.title).toBe('How to make an apple pie') // ai-title wins over slug
    expect(meta.project).toBe('/Users/test/Desktop/Projects/pie')
    expect(meta.gitBranch).toBe('main')
    expect(meta.preview).toContain('apple pie')
  })

  test('normalizes messages: text + tool_use, result attached to the call', () => {
    const { messages } = parseClaudeSession(fixture('claude/v2.1-basic.jsonl'))
    const roles = messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.toolName).toBe('Read')
    expect(tool.filesTouched).toEqual(['/Users/test/Desktop/Projects/pie/recipe.md'])
    expect(tool.toolResult).toBe('flour, apples, butter')
  })

  test('excludes sidechains by default, includes them on request', () => {
    const excluded = parseClaudeSession(fixture('claude/v2.1-basic.jsonl'))
    expect(excluded.messages.some((m) => m.text.includes('subagent'))).toBe(false)

    const included = parseClaudeSession(fixture('claude/v2.1-basic.jsonl'), {
      includeSidechains: true
    })
    expect(included.messages.some((m) => m.isSidechain)).toBe(true)
  })

  test('unknown record types are counted, never fatal', () => {
    const { stats, messages } = parseClaudeSession(fixture('claude/v2.1-basic.jsonl'))
    expect(stats.unknownTypes['some-future-record']).toBe(1)
    expect(messages.length).toBeGreaterThan(0)
  })

  test('fork: follows the active branch, drops the abandoned one', () => {
    const { messages } = parseClaudeSession(fixture('claude/v2.1-fork.jsonl'))
    const texts = messages.map((m) => m.text)
    expect(texts).toContain('actually use plan B')
    expect(texts).toContain('Done with plan B.')
    expect(texts.join(' ')).not.toContain('abandoned branch')
    expect(messages).toHaveLength(4) // u1, a1, u2b, a2b
  })

  test('title falls back to slug when no ai-title record exists', () => {
    const { meta } = parseClaudeSession(fixture('claude/v2.1-fork.jsonl'))
    expect(meta.title).toBe('refactor the auth module') // no slug either → first user msg
  })

  test('command-only session: /clear becomes a chip, messageCount is 0 (hidden)', () => {
    const { meta, messages } = parseClaudeSession(fixture('claude/v2.1-command-only.jsonl'))
    expect(meta.messageCount).toBe(0)
    const chip = messages.find((m) => m.commandName)
    expect(chip?.commandName).toBe('/clear')
    // the local-command-caveat injection is dropped entirely
    expect(messages.some((m) => m.text.includes('Caveat'))).toBe(false)
  })

  test('assistant-only session: title falls back to assistant text, never a UUID', () => {
    const { meta } = parseClaudeSession(fixture('claude/v2.1-assistant-only.jsonl'))
    expect(meta.title).toContain('Back again')
    expect(meta.title).not.toMatch(/^[0-9a-f]{8}-/)
    expect(meta.messageCount).toBe(1)
  })

  test('user-set custom-title outranks generated ai-title', () => {
    const { meta, stats } = parseClaudeSession(fixture('claude/v2.1-custom-title.jsonl'))
    expect(meta.title).toBe('My renamed session')
    // metadata record types observed in the wild are known, not drift
    expect(Object.keys(stats.unknownTypes)).toHaveLength(0)
  })
})

describe('codex adapter', () => {
  test('parses meta from session_meta', () => {
    const { meta } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(meta.id).toBe('019e0000-0000-7000-8000-000000000001')
    expect(meta.source).toBe('codex')
    expect(meta.project).toBe('/Users/test/Desktop/Projects/bread')
    expect(meta.createdAt).toBe('2026-07-03T08:00:00.000Z')
  })

  test('messages come from response_item only; event_msg duplicates ignored', () => {
    const { messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    const assistant = messages.filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1) // not double-counted from agent_message event
    expect(assistant[0].text).toContain('dutch oven')
  })

  test('injected noise (user_instructions, permissions instructions) is filtered', () => {
    const { meta, messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(messages.some((m) => m.text.includes('AGENTS.md'))).toBe(false)
    expect(messages.some((m) => m.text.includes('sandbox_mode'))).toBe(false)
    expect(meta.preview).toContain('sourdough')
    expect(meta.title).not.toContain('permissions')
  })

  test('function_call becomes a tool message with joined command and its output', () => {
    const { messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.toolName).toBe('shell')
    expect(tool.text).toBe('ls -la recipes/')
    expect(tool.toolResult).toBe('sourdough.md')
  })

  test('AGENTS.md injection (markdown header, no tag) is filtered', () => {
    const { meta, messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(messages.some((m) => m.text.includes('AGENTS.md'))).toBe(false)
    expect(meta.title).not.toContain('AGENTS.md')
  })

  test('unknown record types are counted, never fatal', () => {
    const { stats } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(stats.unknownTypes['brand_new_record_type']).toBe(1)
  })

  test('titleIndex overrides preview-derived title', () => {
    const titleIndex = new Map([['019e0000-0000-7000-8000-000000000001', 'Sourdough baking help']])
    const { meta } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'), { titleIndex })
    expect(meta.title).toBe('Sourdough baking help')
  })

  test('missing session_index file yields an empty map, not a crash', () => {
    expect(parseCodexTitleIndex('/nonexistent/session_index.jsonl').size).toBe(0)
  })
})
