import { beforeEach, describe, expect, test } from 'vitest'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeSession } from '../src/shared/adapter/claude'
import { parseCodexSession, parseCodexTitleIndex } from '../src/shared/adapter/codex'
import { resetScanCache, scanAll } from '../src/shared/adapter/scan'
import type { ScanResult } from '../src/shared/adapter/types'

const fixture = (p: string): string => join(__dirname, 'fixtures', p)

describe('claude adapter', () => {
  test('a compaction boundary does not truncate the transcript', () => {
    // The parentUuid walk stops dead at a summary record, because the turn
    // after it parents onto something that is not a message. Following the
    // chain alone returned the last 2 messages of this 6-message session —
    // measured on a real session, 964 records collapsed to 16.
    const { messages, meta } = parseClaudeSession(fixture('claude/v2.1-compacted.jsonl'))
    expect(messages.map((m) => m.text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
      'third question',
      'third answer'
    ])
    // The count the sidebar uses was always whole-timeline; it must still agree
    expect(meta.messageCount).toBe(messages.length)
  })

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

  test('a transcript reports the context it stopped at', () => {
    // A resumed pane shows nothing until it has spoken otherwise: `--resume`
    // replays no history, so the first live reading is a whole turn away.
    const { contextTokens } = parseClaudeSession(fixture('claude/v2.1-usage.jsonl'))
    // The newest *main-branch* record: 8 + 118 + 32,467. The sidechain record
    // between them reports a subagent's 904, which is not this conversation's.
    expect(contextTokens).toBe(32593)
  })

  test('a transcript names the model and effort it was last running on', () => {
    // What a resumed pane's composer shows before its first turn. The
    // sidechain record between the two main ones is a subagent on another
    // model at another effort, and reporting it would put a model the user
    // never chose in front of them.
    const result = parseClaudeSession(fixture('claude/v2.1-usage.jsonl'))
    expect(result.model).toBe('claude-opus-5')
    expect(result.effort).toBe('high')
  })

  test('a transcript that never recorded a turn names neither', () => {
    const result = parseClaudeSession(fixture('claude/v2.1-command-only.jsonl'))
    expect(result.model).toBeUndefined()
    expect(result.effort).toBeUndefined()
  })

  test('a transcript with no usage recorded simply has none', () => {
    expect(parseClaudeSession(fixture('claude/v2.1-basic.jsonl')).contextTokens).toBeUndefined()
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
  test('a rollout names the model and effort of its newest turn', () => {
    // Codex writes a `turn_context` before every turn, and a thread can be
    // moved onto another model mid-conversation — so the opening record is the
    // wrong one to read. This fixture starts on gpt-5.5 and ends on 5.6-sol.
    const result = parseCodexSession(fixture('codex/v0.144-custom-tools.jsonl'))
    expect(result.model).toBe('gpt-5.6-sol')
    expect(result.effort).toBe('high')
  })

  test('an older rollout with no turn_context names neither', () => {
    const result = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(result.model).toBeUndefined()
    expect(result.effort).toBeUndefined()
  })

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

  test('injected noise (instructions, permissions, team-agent bootstrap) is filtered', () => {
    const { meta, messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    expect(messages.some((m) => m.text.includes('AGENTS.md'))).toBe(false)
    expect(messages.some((m) => m.text.includes('sandbox_mode'))).toBe(false)
    expect(messages.some((m) => m.text.includes('primary agent in a team'))).toBe(false)
    expect(meta.preview).toContain('sourdough')
    expect(meta.title).not.toContain('permissions')
    expect(meta.title).not.toContain('primary agent')
  })

  test('function_call becomes a tool message with joined command and its output', () => {
    const { messages } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'))
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.toolName).toBe('shell')
    expect(tool.text).toBe('ls -la recipes/')
    expect(tool.toolResult).toBe('sourdough.md')
  })

  test('custom tool calls preserve shell activity and edited file names', () => {
    const { messages } = parseCodexSession(fixture('codex/v0.144-custom-tools.jsonl'))
    const tools = messages.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      toolName: 'shell',
      toolDisplayName: 'Shell',
      toolInput: { command: 'npm run typecheck' },
      toolResult: 'Script completed\nOutput:\nTypes passed'
    })
    expect(tools[1]).toMatchObject({
      toolName: 'apply_patch',
      toolDisplayName: 'Edit',
      toolInput: {
        path: '/Users/test/chewo/src/main/chat.ts',
        paths: [
          '/Users/test/chewo/src/main/chat.ts',
          '/Users/test/chewo/tests/chat.test.ts'
        ]
      },
      filesTouched: [
        '/Users/test/chewo/src/main/chat.ts',
        '/Users/test/chewo/tests/chat.test.ts'
      ],
      toolResult: '{}'
    })
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

  test('team-agent bootstrap titleIndex entry falls back to the first real prompt', () => {
    const titleIndex = new Map([
      [
        '019e0000-0000-7000-8000-000000000001',
        "You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals."
      ]
    ])
    const { meta } = parseCodexSession(fixture('codex/v0.142-basic.jsonl'), { titleIndex })
    expect(meta.title).toBe('how do I bake sourdough bread?')
  })

  test('missing session_index file yields an empty map, not a crash', () => {
    expect(parseCodexTitleIndex('/nonexistent/session_index.jsonl').size).toBe(0)
  })
})

describe('scan cache', () => {
  const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444'

  /** A claude root holding one project dir with the basic fixture copied in. */
  function tempRoot(): { root: string; transcript: string } {
    const root = mkdtempSync(join(tmpdir(), 'chewo-scan-'))
    const projectDir = join(root, '-Users-test-Desktop-Projects-pie')
    mkdirSync(projectDir)
    const transcript = join(projectDir, `${SESSION_ID}.jsonl`)
    copyFileSync(fixture('claude/v2.1-basic.jsonl'), transcript)
    return { root, transcript }
  }

  const scan = (root: string): ScanResult =>
    scanAll({ claudeRoot: root, codexRoot: join(root, 'no-codex') })

  beforeEach(() => resetScanCache())

  test('an unchanged file is served from cache, not re-parsed', () => {
    const { root } = tempRoot()
    const first = scan(root).sessions
    const second = scan(root).sessions
    expect(first).toHaveLength(1)
    // Same object identity ⇒ the parser never ran the second time
    expect(second[0]).toBe(first[0])
  })

  test('an appended message invalidates the entry', () => {
    const { root, transcript } = tempRoot()
    const before = scan(root).sessions[0]!

    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        uuid: 'u99',
        parentUuid: 'u1',
        isSidechain: false,
        timestamp: '2026-07-01T11:00:00.000Z',
        cwd: '/Users/test/Desktop/Projects/pie',
        sessionId: SESSION_ID,
        message: { role: 'user', content: 'and a lattice top?' }
      }) + '\n'
    )

    const after = scan(root).sessions[0]!
    expect(after).not.toBe(before)
    expect(after.messageCount).toBe(before.messageCount + 1)
  })

  test('a deleted transcript leaves the scan and the cache', () => {
    const { root, transcript } = tempRoot()
    expect(scan(root).sessions).toHaveLength(1)

    rmSync(transcript)
    expect(scan(root).sessions).toHaveLength(0)

    // Restoring identical bytes must parse again rather than resurrect the entry
    copyFileSync(fixture('claude/v2.1-basic.jsonl'), transcript)
    expect(scan(root).sessions).toHaveLength(1)
  })

  test('cache entries are keyed per root, so a second root is not shadowed', () => {
    const a = tempRoot()
    const b = tempRoot()
    expect(scan(a.root).sessions).toHaveLength(1)
    expect(scan(b.root).sessions).toHaveLength(1)
    // Scanning b must not have pruned a's entry
    expect(scan(a.root).sessions).toHaveLength(1)
  })
})
