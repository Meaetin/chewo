import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeChatArgs, createClaudeNormalizer } from '../src/main/claude-chat'
import {
  appendUserMessage,
  emptyChatState,
  pendingApprovals,
  reduceChat,
  seedItems,
  type AgentChatEvent,
  type ChatState
} from '../src/shared/agent-chat'

/** Replay a recorded stream-json capture through normalize → reduce. */
function replay(file: string): { state: ChatState; events: AgentChatEvent[] } {
  const normalize = createClaudeNormalizer()
  const events: AgentChatEvent[] = []
  let state = emptyChatState()
  const raw = readFileSync(join(__dirname, 'fixtures', 'chat', file), 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    for (const event of normalize(JSON.parse(line))) {
      events.push(event)
      state = reduceChat(state, event)
    }
  }
  return { state, events }
}

describe('claude chat argv', () => {
  test('carries the two flags the feature depends on', () => {
    const args = claudeChatArgs({})
    expect(args).toContain('--include-partial-messages')
    // Undocumented, and the whole approval UI rests on it — see claude-chat.ts
    expect(args.join(' ')).toContain('--permission-prompt-tool stdio')
    expect(args.join(' ')).toContain('--input-format stream-json')
    expect(args.join(' ')).toContain('--output-format stream-json')
  })

  test('resume and add-dir are passed as separate argv entries, never quoted', () => {
    const args = claudeChatArgs({ sessionId: 'abc-123', extraDirs: ["/tmp/a b/it's"] })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123')
    expect(args[args.indexOf('--add-dir') + 1]).toBe("/tmp/a b/it's")
  })
})

describe('claude stream normalizer', () => {
  const { state, events } = replay('claude-stream.jsonl')

  test('picks up the session id and slash-command catalog', () => {
    expect(state.info?.sessionId).toBeTruthy()
    expect(state.info?.model).toContain('claude')
    // The composer's `/` palette is fed from this
    expect(state.info!.slashCommands.length).toBeGreaterThan(0)
  })

  test('assistant text is rendered once, not twice', () => {
    // Text arrives as stream deltas AND again in the completed `assistant`
    // message. Emitting both is the bug this guards — it shows up as either a
    // repeated sentence or two items sharing a block id.
    const texts = state.items.filter((i) => i.kind === 'text') as Array<{ id: string; text: string }>
    expect(texts.length).toBeGreaterThan(0)
    expect(new Set(texts.map((t) => t.id)).size).toBe(texts.length)

    const joined = texts.map((t) => t.text).join('\n')
    const sentence = 'The version is **0.1.0**. Writing it to note.txt now.'
    expect(joined.split(sentence).length - 1).toBe(1)
  })

  test('block ids stay unique across messages in a turn', () => {
    // Indices restart at 0 in every message, so an index alone would collide
    // and later blocks would overwrite earlier ones.
    const ids = state.items.filter((i) => i.kind === 'text' || i.kind === 'thinking').map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('thinking is captured as its own collapsible item', () => {
    const thinking = state.items.filter((i) => i.kind === 'thinking')
    expect(thinking.length).toBeGreaterThan(0)
    expect((thinking[0] as { text: string }).text).toContain('package.json')
    expect((thinking[0] as { done: boolean }).done).toBe(true)
  })

  test('a tool call goes running → resolved with its input filled in', () => {
    const read = state.items.find((i) => i.kind === 'tool' && i.call.name === 'Read')
    expect(read).toBeDefined()
    const call = (read as { call: { input: Record<string, unknown>; status: string; result?: string } }).call
    // `input` is empty on content_block_start and filled from the assistant echo
    expect(call.input.file_path).toContain('package.json')
    expect(call.status).toBe('ok')
    expect(call.result).toContain('"version"')
  })

  test('a permission request lands on the matching tool chip', () => {
    const approval = events.find((e) => e.type === 'tool_approval')
    expect(approval).toBeDefined()
    const write = state.items.find((i) => i.kind === 'tool' && i.call.name === 'Write')
    expect(write).toBeDefined()
    // It was answered during the recording, so it must not still be blocking
    expect((write as { call: { status: string } }).call.status).toBe('ok')
    expect(pendingApprovals(state)).toEqual([])
  })

  test('context fullness tracks the prompt, cached tokens included', () => {
    // 8 fresh + 118 written to cache + 32,467 read from cache. Counting only
    // the fresh input would report 8 tokens for a conversation filling 16% of
    // the window — cached tokens still occupy it, only their price differs.
    expect(state.usage.contextTokens).toBe(8 + 118 + 32467)
    // Stated once per turn, in `result` — the only place the window's size appears
    expect(state.usage.contextWindow).toBe(200000)
  })

  test('the rate-limit window is reported as a window, not as a quantity', () => {
    // The whole payload: which window binds, its status, when it rolls over.
    // No utilization figure exists on this event — `/usage`'s percentages come
    // from an authenticated call the CLI makes and Chewo does not.
    expect(state.usage.limitType).toBe('five_hour')
    expect(state.usage.limitStatus).toBe('allowed')
    expect(state.usage.limitResetsAt).toBe(1785671400)
  })

  test('turn ends carry cost', () => {
    const turns = state.items.filter((i) => i.kind === 'turn')
    expect(turns.length).toBe(2)
    expect((turns[0] as { stats: { costUsd?: number } }).stats.costUsd).toBeGreaterThan(0)
  })
})

describe('context readout', () => {
  test("a subagent's prompt is not the pane's context", () => {
    // Subagent messages carry their own (much smaller) usage. Letting them
    // through makes the reading drop to a few hundred tokens every time a Task
    // runs, then jump back — the number would be unreadable during the one
    // kind of turn where it matters most.
    const normalize = createClaudeNormalizer()
    const main = normalize({
      type: 'assistant',
      message: { id: 'msg_1', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 900 } }
    })
    expect(main).toEqual([{ type: 'usage', usage: { contextTokens: 1000 } }])

    const sub = normalize({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { id: 'msg_2', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 20 } }
    })
    expect(sub).toEqual([])
  })

  test('the window comes from the pane’s own model, not a subagent’s', () => {
    const normalize = createClaudeNormalizer()
    normalize({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5', cwd: '/tmp' })
    const events = normalize({
      type: 'result',
      subtype: 'success',
      is_error: false,
      modelUsage: {
        'claude-haiku-4-5-20251001': { contextWindow: 200000, inputTokens: 10, cacheReadInputTokens: 40 },
        'claude-opus-5': { contextWindow: 1000000, inputTokens: 500, cacheReadInputTokens: 90000 }
      }
    })
    expect(events[0]).toEqual({ type: 'usage', usage: { contextWindow: 1000000 } })
    // The turn boundary still arrives, and still last
    expect(events[events.length - 1].type).toBe('turn_end')
  })
})

describe('resumed history', () => {
  test('a stored transcript becomes chat items', () => {
    // `--resume` replays nothing over the wire, so a resumed pane would open
    // blank without this.
    const items = seedItems([
      { role: 'user', text: 'add a test' },
      { role: 'assistant', text: 'On it.' },
      {
        role: 'tool',
        text: 'src/a.ts',
        toolName: 'apply_patch',
        toolDisplayName: 'Edit',
        toolInput: { path: 'src/a.ts' },
        toolResult: 'contents'
      },
      { role: 'assistant', text: 'Done.' }
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'text'])
    const tool = items[2] as {
      call: { name: string; displayName?: string; input: unknown; status: string; result?: string }
    }
    expect(tool.call.name).toBe('apply_patch')
    expect(tool.call.displayName).toBe('Edit')
    expect(tool.call.input).toEqual({ path: 'src/a.ts' })
    // Nothing historical can be approved or cancelled after the fact
    expect(tool.call.status).toBe('ok')
    expect(tool.call.result).toBe('contents')
    expect((items[1] as { done: boolean }).done).toBe(true)
  })

  test('slash commands survive as the user turn they were', () => {
    const items = seedItems([{ role: 'user', text: '', commandName: 'compact' }])
    expect(items).toEqual([{ kind: 'user', id: 'seed-0', text: '/compact' }])
  })

  test('a command that already carries its slash does not get a second one', () => {
    // What Claude actually writes: `<command-name>/effort</command-name>`.
    const items = seedItems([{ role: 'user', text: '', commandName: '/effort low' }])
    expect(items).toEqual([{ kind: 'user', id: 'seed-0', text: '/effort low' }])
  })

  test('seeded ids cannot collide with live ones', () => {
    // Live ids are `messageId:index` and tool_use ids; a collision would make
    // a delta land on a history item.
    const items = seedItems([
      { role: 'assistant', text: 'hi' },
      { role: 'tool', text: '', toolName: 'Bash' }
    ])
    expect(items.every((i) => i.id.startsWith('seed-'))).toBe(true)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  test('an assistant turn with no text is dropped rather than seeded empty', () => {
    expect(seedItems([{ role: 'assistant', text: '' }])).toEqual([])
  })
})

describe('reducer', () => {
  test('an approval parks the tool until answered', () => {
    let state = emptyChatState()
    state = reduceChat(state, {
      type: 'tool_start',
      call: { toolUseId: 't1', name: 'Bash', input: {}, status: 'running' }
    })
    state = reduceChat(state, {
      type: 'tool_approval',
      toolUseId: 't1',
      requestId: 'r1',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    })
    expect(pendingApprovals(state)).toHaveLength(1)
    expect(pendingApprovals(state)[0].requestId).toBe('r1')

    state = reduceChat(state, { type: 'tool_result', toolUseId: 't1', result: 'hi', isError: false })
    expect(pendingApprovals(state)).toEqual([])
    expect((state.items[0] as { call: { status: string } }).call.status).toBe('ok')
  })

  test('events for unknown blocks are dropped, not thrown', () => {
    const state = emptyChatState()
    expect(() => reduceChat(state, { type: 'block_delta', blockId: 'nope', text: 'x' })).not.toThrow()
    expect(reduceChat(state, { type: 'block_delta', blockId: 'nope', text: 'x' }).items).toEqual([])
    expect(reduceChat(state, { type: 'tool_input', toolUseId: 'nope', input: {} }).items).toEqual([])
  })

  test('a denied tool reads as denied, not as a failure', () => {
    let state = emptyChatState()
    state = reduceChat(state, {
      type: 'tool_start',
      call: { toolUseId: 't1', name: 'Bash', input: {}, status: 'denied' }
    })
    // The CLI reports a denial as an error result; the chip must not say "failed"
    state = reduceChat(state, { type: 'tool_result', toolUseId: 't1', result: 'denied', isError: true })
    expect((state.items[0] as { call: { status: string } }).call.status).toBe('denied')
  })

  test('user messages are appended locally — the CLI never echoes them', () => {
    const state = appendUserMessage(emptyChatState(), 'hello')
    expect(state.items).toEqual([{ kind: 'user', id: 'user-0', text: 'hello' }])
  })

  test('the handshake fills the slash palette before any turn has run', () => {
    // The CLI withholds system/init until the first turn, so without the
    // startup handshake the `/` palette is empty exactly when a user would
    // first reach for it.
    let state = reduceChat(emptyChatState(), {
      type: 'session',
      info: { sessionId: '', model: '', cwd: '/repo', slashCommands: [], mcpServers: [] }
    })
    expect(state.info?.slashCommands).toEqual([])

    state = reduceChat(state, { type: 'capabilities', slashCommands: ['context', 'compact'] })
    expect(state.info?.slashCommands).toEqual(['context', 'compact'])
    expect(state.info?.cwd).toBe('/repo')
  })

  test('a later system/init does not wipe the commands the handshake found', () => {
    let state = reduceChat(emptyChatState(), {
      type: 'capabilities',
      slashCommands: ['context']
    })
    state = reduceChat(state, {
      type: 'session',
      info: { sessionId: 's1', model: 'opus', cwd: '/repo', slashCommands: [], mcpServers: [] }
    })
    expect(state.info?.sessionId).toBe('s1')
    expect(state.info?.slashCommands).toEqual(['context'])
  })

  test('a tool still running when the turn ends stops spinning', () => {
    // After an interrupt the CLI just stops — no tool_result ever arrives, so
    // the chip span forever until the turn end settled it.
    let state = reduceChat(emptyChatState(), {
      type: 'tool_start',
      call: { toolUseId: 't1', name: 'Bash', input: {}, status: 'running' }
    })
    state = reduceChat(state, { type: 'turn_end', stats: { isError: true, cancelled: true } })
    expect((state.items[0] as { call: { status: string } }).call.status).toBe('cancelled')
    expect(state.busy).toBe(false)
  })

  test('an interrupt settles a parked approval too', () => {
    let state = reduceChat(emptyChatState(), {
      type: 'tool_start',
      call: { toolUseId: 't1', name: 'Write', input: {}, status: 'running' }
    })
    state = reduceChat(state, {
      type: 'tool_approval',
      toolUseId: 't1',
      requestId: 'r1',
      suggestions: []
    })
    state = reduceChat(state, { type: 'turn_end', stats: { isError: false, cancelled: true } })
    expect(pendingApprovals(state)).toEqual([])
    expect((state.items[0] as { call: { status: string } }).call.status).toBe('cancelled')
  })

  test('cancelling is distinguishable from failing', () => {
    const cancelled = reduceChat(emptyChatState(), {
      type: 'turn_end',
      stats: { isError: true, cancelled: true }
    })
    const failed = reduceChat(emptyChatState(), { type: 'turn_end', stats: { isError: true } })
    // Both come back from the CLI as is_error; only the flag separates them,
    // and the UI must not call a deliberate stop an error.
    expect((cancelled.items[0] as { stats: { cancelled?: boolean } }).stats.cancelled).toBe(true)
    expect((failed.items[0] as { stats: { cancelled?: boolean } }).stats.cancelled).toBeUndefined()
  })

  test('exit stops the busy spinner', () => {
    let state = reduceChat(emptyChatState(), { type: 'busy', busy: true })
    state = reduceChat(state, { type: 'exit', code: 1 })
    expect(state.busy).toBe(false)
    expect(state.exitCode).toBe(1)
  })
})
