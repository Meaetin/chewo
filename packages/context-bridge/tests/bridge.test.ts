import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { digestSession, fullSessionPage, searchSessions } from '../src/store'
import { checkInbox, writeHandoff } from '../src/inbox'
import { buildServer } from '../src/server'
import { parseClaudeSession } from '../../../src/shared/adapter'

const FIXTURES = join(__dirname, '../../../tests/fixtures')

let tmp: string
let claudeRoot: string
let codexRoot: string
let bridgeRoot: string

/** Build fake ~/.claude/projects and ~/.codex trees from the shared fixtures */
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  claudeRoot = join(tmp, 'claude-projects')
  codexRoot = join(tmp, 'codex')
  bridgeRoot = join(tmp, 'bridge')

  const projDir = join(claudeRoot, '-Users-test-Desktop-Projects-pie')
  mkdirSync(projDir, { recursive: true })
  cpSync(join(FIXTURES, 'claude/v2.1-basic.jsonl'), join(projDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'))
  cpSync(join(FIXTURES, 'claude/v2.1-fork.jsonl'), join(projDir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'))

  const codexDay = join(codexRoot, 'sessions/2026/07/03')
  mkdirSync(codexDay, { recursive: true })
  cpSync(
    join(FIXTURES, 'codex/v0.142-basic.jsonl'),
    join(codexDay, 'rollout-2026-07-03T08-00-00-019e0000-0000-7000-8000-000000000001.jsonl')
  )
  writeFileSync(
    join(codexRoot, 'session_index.jsonl'),
    JSON.stringify({ id: '019e0000-0000-7000-8000-000000000001', thread_name: 'Sourdough baking help' }) + '\n'
  )
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('searchSessions', () => {
  test('finds the apple pie session across sources by topic words', () => {
    const results = searchSessions('how to make an apple', { claudeRoot, codexRoot })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toBe('How to make an apple pie')
    expect(results[0].source).toBe('claude')
  })

  test('finds codex sessions via session_index titles', () => {
    const results = searchSessions('sourdough baking', { claudeRoot, codexRoot })
    expect(results[0].title).toBe('Sourdough baking help')
    expect(results[0].source).toBe('codex')
  })

  test('returns empty for no matches, respects source filter', () => {
    expect(searchSessions('quantum blockchain', { claudeRoot, codexRoot })).toHaveLength(0)
    const codexOnly = searchSessions('apple pie', { claudeRoot, codexRoot, source: 'codex' })
    expect(codexOnly).toHaveLength(0)
  })

  test('boostPath ranks current-project sessions first without hiding others', () => {
    // "how" hits the pie session (title+preview) harder than the bread session
    // (preview only) — the cwd boost must flip the order without dropping results.
    const neutral = searchSessions('how', { claudeRoot, codexRoot, limit: 10 })
    expect(neutral.length).toBeGreaterThanOrEqual(2)
    expect(neutral[0].project).toBe('/Users/test/Desktop/Projects/pie')

    const boosted = searchSessions('how', {
      claudeRoot,
      codexRoot,
      limit: 10,
      boostPath: '/Users/test/Desktop/Projects/bread'
    })
    expect(boosted[0].project).toBe('/Users/test/Desktop/Projects/bread')
    // cross-project result still present — boost, not filter
    expect(boosted.length).toBe(neutral.length)
  })
})

describe('digest & pagination', () => {
  test('digest contains user messages, final reply, and files touched', () => {
    const result = parseClaudeSession(join(FIXTURES, 'claude/v2.1-basic.jsonl'))
    const digest = digestSession(result)
    expect(digest).toContain('apple pie')
    expect(digest).toContain('Final assistant reply')
    expect(digest).toContain('recipe.md')
  })

  test('digest respects the hard char cap on a bloated session', () => {
    const result = parseClaudeSession(join(FIXTURES, 'claude/v2.1-basic.jsonl'))
    const bloated = {
      ...result,
      messages: Array.from({ length: 200 }, (_, i) => ({
        role: 'user' as const,
        text: `user message number ${i} `.repeat(50)
      }))
    }
    expect(digestSession(bloated, 8000).length).toBeLessThanOrEqual(8000)
  })

  test('full mode paginates and clamps out-of-range pages', () => {
    const result = parseClaudeSession(join(FIXTURES, 'claude/v2.1-basic.jsonl'))
    const page = fullSessionPage(result, 999)
    expect(page.page).toBe(page.totalPages)
    expect(page.text).toContain('page')
  })
})

describe('inbox', () => {
  test('handoff roundtrip: write for codex, codex reads and clears', () => {
    writeHandoff({ from: 'claude', to: 'codex', note: 'API schema settled: /v2/items', sessionId: 'abc' }, bridgeRoot)
    const items = checkInbox('codex', bridgeRoot)
    expect(items).toHaveLength(1)
    expect(items[0].note).toContain('/v2/items')
    expect(items[0].from).toBe('claude')
    // cleared after read
    expect(checkInbox('codex', bridgeRoot)).toHaveLength(0)
  })

  test('inbox is per-agent — claude does not see codex handoffs', () => {
    writeHandoff({ from: 'claude', to: 'codex', note: 'for codex only' }, bridgeRoot)
    expect(checkInbox('claude', bridgeRoot)).toHaveLength(0)
    expect(checkInbox('codex', bridgeRoot)).toHaveLength(1)
  })
})

describe('MCP server integration (InMemoryTransport)', () => {
  async function connect(agent: 'claude' | 'codex') {
    const server = buildServer({ agent, claudeRoot, codexRoot, bridgeRoot })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
  }

  const textOf = (result: any): string => result.content[0].text

  test('exposes all five tools', async () => {
    const client = await connect('claude')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_inbox',
      'get_session',
      'handoff',
      'list_recent_sessions',
      'search_sessions'
    ])
  })

  test('the full "refer to that chat" flow: search → get_session', async () => {
    const client = await connect('codex')
    const search = await client.callTool({
      name: 'search_sessions',
      arguments: { query: 'how to make an apple' }
    })
    const candidates = JSON.parse(textOf(search))
    expect(candidates[0].title).toBe('How to make an apple pie')

    const session = await client.callTool({
      name: 'get_session',
      arguments: { id: candidates[0].id }
    })
    expect(textOf(session)).toContain('flour, apples, and butter')
  })

  test('cross-agent handoff flow: claude hands off, codex checks inbox', async () => {
    const claudeClient = await connect('claude')
    const codexClient = await connect('codex')

    await claudeClient.callTool({
      name: 'handoff',
      arguments: { to: 'codex', note: 'Use plan B for the refactor', session_id: 'bbbbbbbb-1111-2222-3333-444444444444' }
    })

    const inbox = await codexClient.callTool({ name: 'check_inbox', arguments: {} })
    const items = JSON.parse(textOf(inbox))
    expect(items[0].note).toBe('Use plan B for the refactor')
    expect(items[0].from).toBe('claude')

    // codex can pull the referenced session for depth
    const session = await codexClient.callTool({
      name: 'get_session',
      arguments: { id: items[0].sessionId, mode: 'summary' }
    })
    expect(textOf(session)).toContain('plan B')
  })

  test('get_session with unknown id fails gracefully', async () => {
    const client = await connect('claude')
    const result = await client.callTool({ name: 'get_session', arguments: { id: 'nope' } })
    expect(textOf(result)).toContain('No session found')
  })
})
