import { beforeEach, describe, expect, test, vi } from 'vitest'

// `settings.ts` reaches for electron's `app` for the userData path, and the
// runner spawns a real CLI — neither belongs in a unit test of the text layer.
// A plain mutable stub rather than `vi.fn()`: the mock's own result tracking
// reports a rejection these functions deliberately swallow as an unhandled one.
let answer: () => Promise<unknown>
vi.mock('../src/main/settings', () => ({ agentFor: () => ({ agent: 'claude' }) }))
vi.mock('../src/main/agent-runner', () => ({ runAgentJson: () => answer() }))

const { budgetDiff, suggestCommitMessage, suggestPrText, unwrapBody } = await import(
  '../src/main/git-text'
)

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

// A 72-column commit body is a `git log` convention that fights the text box
// it is now edited in: the field soft-wraps text that is already hard-wrapped,
// and changing a word leaves the paragraph re-flowed by hand or not at all.
describe('unwrapBody', () => {
  test('joins hard-wrapped lines back into paragraphs', () => {
    expect(
      unwrapBody('Ship previously forced both ends of its route: the branch\nname came from the task slug.')
    ).toBe('Ship previously forced both ends of its route: the branch name came from the task slug.')
  })

  test('blank lines are real structure and survive', () => {
    expect(unwrapBody('One wrapped\nparagraph.\n\nAnd a\nsecond.')).toBe(
      'One wrapped paragraph.\n\nAnd a second.'
    )
  })

  test('leaves blocks where the newline is load-bearing', () => {
    expect(unwrapBody('- first item\n- second item')).toBe('- first item\n- second item')
    expect(unwrapBody('1. one\n2. two')).toBe('1. one\n2. two')
    expect(unwrapBody('> quoted\n> lines')).toBe('> quoted\n> lines')
    expect(unwrapBody('    const x = 1\n    const y = 2')).toBe('    const x = 1\n    const y = 2')
  })

  test('a body that was never wrapped is unchanged', () => {
    expect(unwrapBody('One line, already fine.')).toBe('One line, already fine.')
    expect(unwrapBody('')).toBe('')
  })

  test('runs of blank lines collapse to one break', () => {
    expect(unwrapBody('one\n\n\n\ntwo')).toBe('one\n\ntwo')
  })
})

/**
 * `git diff` emits files in path order, so slicing the whole diff is a lottery
 * held on filenames — the real bug was a four-file change whose `AGENTS.md`
 * hunk sorted first and consumed the entire budget, leaving the model to write
 * a confident subject about code it had never been shown.
 */
describe('budgetDiff', () => {
  const file = (name: string, lines: number): string =>
    [`diff --git a/${name} b/${name}`, '--- a/' + name, '+++ b/' + name]
      .concat(Array.from({ length: lines }, (_, i) => `+line ${i} of ${name}`))
      .join('\n')

  const named = (out: string): string[] =>
    (out.match(/^diff --git a\/(\S+)/gm) ?? []).map((l) => l.split('a/')[1])

  test('a diff inside the budget is passed through untouched', () => {
    const diff = [file('a.ts', 3), file('b.ts', 3)].join('\n')
    expect(budgetDiff(diff, 10_000)).toBe(diff)
  })

  test('every changed file survives, however the first one sorts', () => {
    const diff = [file('AGENTS.md', 400), file('src/app.tsx', 5), file('src/styles.css', 5)].join(
      '\n'
    )
    const out = budgetDiff(diff, 800)
    expect(named(out)).toEqual(['AGENTS.md', 'src/app.tsx', 'src/styles.css'])
    // The small files are whole — only the hog gets cut
    expect(out).toContain('+line 4 of src/styles.css')
    expect(out.length).toBeLessThanOrEqual(800)
  })

  test('what was dropped is announced, never silently cut', () => {
    const out = budgetDiff([file('big.ts', 300), file('small.ts', 2)].join('\n'), 600)
    expect(out).toMatch(/more lines of this file's diff not shown/)
  })

  test('a single-file diff still truncates rather than blowing the budget', () => {
    const out = budgetDiff(file('only.ts', 500), 400)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toContain('diff truncated')
  })
})
