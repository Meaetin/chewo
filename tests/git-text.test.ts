import { beforeEach, describe, expect, test, vi } from 'vitest'

// `settings.ts` reaches for electron's `app` for the userData path, and the
// runner spawns a real CLI — neither belongs in a unit test of the text layer.
// A plain mutable stub rather than `vi.fn()`: the mock's own result tracking
// reports a rejection these functions deliberately swallow as an unhandled one.
let answer: () => Promise<unknown>
vi.mock('../src/main/settings', () => ({ agentFor: () => ({ agent: 'claude' }) }))
vi.mock('../src/main/agent-runner', () => ({ runAgentJson: () => answer() }))

const { suggestCommitMessage, suggestPrText } = await import('../src/main/git-text')

const answers = (value: unknown): void => {
  answer = async () => value
}
const fails = (message: string): void => {
  answer = () => Promise.reject(new Error(message))
}

beforeEach(() => fails('no stub set'))

describe('suggestCommitMessage', () => {
  test('takes the agent subject, first line only, and trims the body', async () => {
    answers({ subject: 'fix: stop the drag\nignored', body: ' why \n' })
    expect(await suggestCommitMessage('stat', 'diff', 3)).toEqual({
      subject: 'fix: stop the drag',
      body: 'why'
    })
  })

  test('a failed agent still yields a committable message', async () => {
    fails('nope')
    expect(await suggestCommitMessage('stat', 'diff', 1)).toEqual({
      subject: 'chore: update 1 file',
      body: ''
    })
    expect(await suggestCommitMessage('stat', 'diff', 4)).toEqual({
      subject: 'chore: update 4 files',
      body: ''
    })
  })

  test('an answer with no subject is treated as no answer', async () => {
    answers({ subject: '   ' })
    expect((await suggestCommitMessage('stat', 'diff', 2)).subject).toBe(
      'chore: update 2 files'
    )
  })
})

describe('suggestPrText', () => {
  test('a single commit becomes the title when the agent is unavailable', async () => {
    fails('nope')
    const out = await suggestPrText('fix-drag', ['a1b2c3d fix: stop the drag'], 'stat')
    expect(out.title).toBe('fix: stop the drag')
    expect(out.body).toBe('- fix: stop the drag')
  })

  test('several commits fall back to a branch summary and a bullet list', async () => {
    fails('nope')
    const out = await suggestPrText('fix-drag', ['aaaaaaa one', 'bbbbbbb two'], 'stat')
    expect(out.title).toBe('fix-drag: 2 commits')
    expect(out.body).toBe('- one\n- two')
  })

  test('prefers the agent title', async () => {
    answers({ title: 'Stop the drag regression', body: '## why' })
    const out = await suggestPrText('fix-drag', ['aaaaaaa one'], 'stat')
    expect(out).toEqual({ title: 'Stop the drag regression', body: '## why' })
  })
})
