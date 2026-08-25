import { describe, expect, test } from 'vitest'
import {
  CODEX_THREAD_ID,
  codexApprovalMessage,
  codexStartupMessages,
  codexTurnMessage,
  createCodexNormalizer
} from '../src/main/codex-chat'
import { parseCodexAccountUsage } from '../src/main/codex-usage'
import { emptyChatState, reduceChat, type AgentChatEvent } from '../src/shared/agent-chat'

const options = {
  cwd: '/repo',
  model: 'gpt-5.6-sol',
  effort: 'high',
  approvalPolicy: 'on-request'
}

describe('codex app-server requests', () => {
  test('initializes before starting a configured thread', () => {
    const messages = codexStartupMessages(options) as Array<Record<string, unknown>>
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start'
    ])
    expect(messages[2]).toMatchObject({
      id: CODEX_THREAD_ID,
      params: { cwd: '/repo', model: 'gpt-5.6-sol', approvalPolicy: 'on-request' }
    })
  })

  test('resumes by thread id and sends text plus local images as one turn', () => {
    const messages = codexStartupMessages({ ...options, sessionId: 'thread-1' }) as Array<
      Record<string, unknown>
    >
    expect(messages[2]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-1' }
    })
    expect(codexTurnMessage(10, 'thread-1', 'inspect it', ['/tmp/a.png'], 'high')).toMatchObject({
      method: 'turn/start',
      id: 10,
      params: {
        threadId: 'thread-1',
        effort: 'high',
        input: [
          { type: 'text', text: 'inspect it', text_elements: [] },
          { type: 'localImage', path: '/tmp/a.png' }
        ]
      }
    })
  })
})

describe('codex app-server normalizer', () => {
  test('folds a streamed turn into the provider-neutral chat state', () => {
    const codex = createCodexNormalizer(options)
    let state = emptyChatState()
    const feed = (raw: unknown): AgentChatEvent[] => {
      const events = codex.normalize(raw).events
      for (const event of events) state = reduceChat(state, event)
      return events
    }

    feed({
      id: CODEX_THREAD_ID,
      result: { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol', cwd: '/repo' }
    })
    feed({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    feed({
      method: 'item/started',
      params: { item: { type: 'reasoning', id: 'reason-1', summary: [], content: [] } }
    })
    feed({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reason-1', delta: 'Checking the repo.' }
    })
    feed({
      method: 'item/completed',
      params: {
        item: { type: 'reasoning', id: 'reason-1', summary: ['Checking the repo.'], content: [] }
      }
    })
    feed({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          status: 'inProgress'
        }
      }
    })
    feed({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          status: 'completed',
          aggregatedOutput: 'ok'
        }
      }
    })
    feed({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg-1', text: '' } } })
    feed({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Done' } })
    feed({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'msg-1', text: 'Done.' } }
    })
    feed({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: { last: { inputTokens: 32_000 }, modelContextWindow: 200_000 }
      }
    })
    feed({
      method: 'turn/plan/updated',
      params: { plan: [{ step: 'Add the adapter', status: 'completed' }] }
    })
    feed({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', durationMs: 1500, error: null } }
    })

    expect(state.info).toMatchObject({
      sessionId: 'thread-1',
      model: 'gpt-5.6-sol',
      cwd: '/repo',
      slashCommands: []
    })
    expect(state.items.find((item) => item.kind === 'thinking')).toMatchObject({
      text: 'Checking the repo.',
      done: true
    })
    expect(state.items.find((item) => item.kind === 'tool')).toMatchObject({
      call: { name: 'shell', status: 'ok', result: 'ok' }
    })
    expect(state.items.find((item) => item.kind === 'text')).toMatchObject({ text: 'Done.', done: true })
    expect(state.usage).toEqual({ contextTokens: 32_000, contextWindow: 200_000 })
    expect(state.tasks).toEqual([
      { id: 'codex-plan-0', subject: 'Add the adapter', status: 'completed' }
    ])
    expect(state.busy).toBe(false)
  })

  test('normalizes command approval and preserves the server request id', () => {
    const codex = createCodexNormalizer(options)
    const normalized = codex.normalize({
      method: 'item/commandExecution/requestApproval',
      id: 42,
      params: {
        itemId: 'cmd-1',
        command: 'npm install',
        cwd: '/repo',
        reason: 'Needs network',
        availableDecisions: ['accept', 'acceptForSession', 'decline']
      }
    })
    expect(normalized.events.map((event) => event.type)).toEqual(['tool_start', 'tool_approval'])
    expect(normalized.pending).toMatchObject({ wireId: 42, toolUseId: 'cmd-1', kind: 'command' })
    expect(
      codexApprovalMessage(normalized.pending!, {
        behavior: 'allow',
        suggestion: { type: 'codexAcceptForSession' }
      })
    ).toEqual({ id: 42, result: { decision: 'acceptForSession' } })
  })

  test('turn interruption is not rendered as an error', () => {
    const codex = createCodexNormalizer(options)
    const { events } = codex.normalize({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'interrupted', error: null } }
    })
    expect(events).toEqual([
      {
        type: 'turn_end',
        stats: { durationMs: undefined, isError: false, cancelled: true }
      }
    ])
  })

  test('learns the turn id from the start response before notifications arrive', () => {
    const codex = createCodexNormalizer(options)
    codex.normalize({ id: 10, result: { turn: { id: 'turn-early' } } })
    expect(codex.turnId()).toBe('turn-early')
  })

  test('hides retry noise but keeps the final app-server error', () => {
    const codex = createCodexNormalizer(options)
    expect(
      codex.normalize({
        method: 'error',
        params: { willRetry: true, error: { message: 'reconnecting' } }
      }).events
    ).toEqual([])
    expect(
      codex.normalize({
        method: 'error',
        params: { willRetry: false, error: { message: 'network unavailable' } }
      }).events
    ).toEqual([{ type: 'notice', tone: 'error', text: 'network unavailable' }])
  })
})

describe('codex account usage', () => {
  test('maps primary and secondary windows without Claude credentials', () => {
    expect(
      parseCodexAccountUsage(
        {
          rateLimitsByLimitId: {
            codex: {
              primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 100 },
              secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 200 }
            }
          }
        },
        1
      )
    ).toEqual({
      fetchedAt: 1,
      windows: [
        { type: 'five_hour', used: 34, resetsAt: 100, priority: 0 },
        { type: 'seven_day', used: 3, resetsAt: 200, priority: 1 }
      ]
    })
  })
})
