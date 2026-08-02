import { describe, expect, test } from 'vitest'
import { branchNameFor, slugifyBranch, uniqueBranchName } from '../src/shared/branch-names'

describe('slugifyBranch', () => {
  test('kebabs a sentence and drops filler', () => {
    expect(slugifyBranch('Fix the drag regression on tabs')).toBe('fix-drag-regression-tabs')
  })

  test('strips punctuation and non-ASCII rather than transliterating', () => {
    expect(slugifyBranch('Add café support (v2)!')).toBe('add-caf-support-v2')
  })

  test('keeps filler when it is all there is', () => {
    expect(slugifyBranch('can you please')).toBe('can-you-please')
  })

  test('caps the word count and never ends on a hyphen', () => {
    const out = slugifyBranch('one two three four five six seven eight')
    expect(out).toBe('one-two-three-four-five')
    expect(out.endsWith('-')).toBe(false)
  })

  test('empty in, empty out — the caller supplies the fallback', () => {
    expect(slugifyBranch('   !!!   ')).toBe('')
  })

  // The result is both an argv element and a directory name under
  // ~/.chewo/worktrees, so traversal must not survive the slug
  test('collapses a path to its words', () => {
    expect(slugifyBranch('../../etc/passwd')).toBe('etc-passwd')
    expect(slugifyBranch('/')).toBe('')
  })
})

describe('uniqueBranchName', () => {
  test('leaves a free name alone', () => {
    expect(uniqueBranchName('fix-drag', ['other'])).toBe('fix-drag')
  })

  test('suffixes past every collision', () => {
    expect(uniqueBranchName('fix-drag', ['fix-drag'])).toBe('fix-drag-2')
    expect(uniqueBranchName('fix-drag', ['fix-drag', 'fix-drag-2'])).toBe('fix-drag-3')
  })
})

describe('branchNameFor', () => {
  test('names a worktree from the first message', () => {
    expect(branchNameFor('fix the drag regression on tabs')).toBe('fix-drag-regression-tabs')
  })

  test('never returns an empty name', () => {
    expect(branchNameFor('!!!')).toBe('task')
    expect(branchNameFor('')).toBe('task')
  })

  test('dodges names the project already uses', () => {
    expect(branchNameFor('fix drag', ['fix-drag'])).toBe('fix-drag-2')
  })
})
