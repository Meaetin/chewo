import { describe, expect, it } from 'vitest'
import { composeAnswers, parseAskQuestions } from '../src/shared/ask-user-question'
import { emptyChatState, reduceChat, type ChatState } from '../src/shared/agent-chat'

/** The `can_use_tool` input recorded from CLI 2.1.220 on 2026-08-03. */
const INPUT = {
  questions: [
    {
      question: 'Do you prefer tabs or spaces for indentation?',
      header: 'Indentation',
      multiSelect: false,
      options: [
        { label: 'Tabs', description: 'Use tab characters' },
        { label: 'Spaces', description: 'Use spaces' }
      ]
    }
  ]
}

describe('parseAskQuestions', () => {
  it('reads the question set', () => {
    const questions = parseAskQuestions(INPUT)!
    expect(questions).toHaveLength(1)
    expect(questions[0].header).toBe('Indentation')
    expect(questions[0].options.map((o) => o.label)).toEqual(['Tabs', 'Spaces'])
  })

  it('returns null for anything that is not a question set', () => {
    // An interactive tool we have never seen must fall back to Allow/Deny
    // rather than render an empty dialog
    expect(parseAskQuestions({ file_path: '/a.txt' })).toBeNull()
    expect(parseAskQuestions({ questions: [] })).toBeNull()
    expect(parseAskQuestions({ questions: [{ header: 'No question text' }] })).toBeNull()
    expect(parseAskQuestions(undefined)).toBeNull()
  })
})

describe('composeAnswers', () => {
  const questions = parseAskQuestions(INPUT)!

  it('keys answers by question text, not by header', () => {
    // Keying by `header` is what silently produced "The user did not answer"
    expect(composeAnswers(questions, [['Tabs']])).toEqual({
      'Do you prefer tabs or spaces for indentation?': 'Tabs'
    })
  })

  it('joins a multi-select into one comma-separated string', () => {
    expect(composeAnswers(questions, [['Tabs', 'Spaces']])).toEqual({
      'Do you prefer tabs or spaces for indentation?': 'Tabs, Spaces'
    })
  })

  it('omits an unanswered question rather than sending it empty', () => {
    expect(composeAnswers(questions, [[]])).toEqual({})
    expect(composeAnswers(questions, [['  ']])).toEqual({})
  })
})

describe('reduceChat / interactive approvals', () => {
  const start = (): ChatState =>
    reduceChat(emptyChatState(), {
      type: 'tool_start',
      call: { toolUseId: 't1', name: 'AskUserQuestion', input: {}, status: 'running' }
    })

  it('carries the interaction flag and the request’s own input onto the call', () => {
    const state = reduceChat(start(), {
      type: 'tool_approval',
      toolUseId: 't1',
      requestId: 'r1',
      input: INPUT,
      requiresUserInteraction: true,
      suggestions: []
    })
    const call = state.items.find((i) => i.kind === 'tool')!
    expect(call.kind === 'tool' && call.call.requiresUserInteraction).toBe(true)
    expect(call.kind === 'tool' && call.call.input).toEqual(INPUT)
  })

  it('keeps the assistant message’s input when the request omits it', () => {
    const withInput = reduceChat(start(), { type: 'tool_input', toolUseId: 't1', input: INPUT })
    const state = reduceChat(withInput, {
      type: 'tool_approval',
      toolUseId: 't1',
      requestId: 'r1',
      suggestions: []
    })
    const call = state.items.find((i) => i.kind === 'tool')!
    expect(call.kind === 'tool' && call.call.input).toEqual(INPUT)
  })
})
