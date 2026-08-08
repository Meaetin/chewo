import { describe, expect, test } from 'vitest'
import {
  branchNameFor,
  branchNameFromSubject,
  slugifyBranch,
  uniqueBranchName
} from '../src/shared/branch-names'

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

  // An apostrophe used to become a space, so "picker's" split into two words
  // and the orphaned "s" both read as noise and spent a word slot
  test('swallows an apostrophe instead of breaking the word', () => {
    expect(slugifyBranch("label base picker's two modes")).toBe('label-base-pickers-two-modes')
    expect(slugifyBranch("don't drop the caret")).toBe('dont-drop-caret')
  })

  // Slicing the joined string cut mid-word; the cap packs whole words now
  test('never cuts a word in half at the character cap', () => {
    const out = slugifyBranch('reconciliation subscription notification authorization deduplication', 5)
    expect(out).toBe('reconciliation-subscription-notification')
    expect(out.length).toBeLessThanOrEqual(48)
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

// Ship names a branch from a subject a model wrote off the real diff, which is
// why it can do better than the task text a session start has to work from.
describe('branchNameFromSubject', () => {
  test('a conventional-commit type becomes the branch prefix', () => {
    expect(branchNameFromSubject('feat: add oauth callback')).toBe('feat/add-oauth-callback')
    expect(branchNameFromSubject('fix: handle empty diff')).toBe('fix/handle-empty-diff')
    expect(branchNameFromSubject('refactor!: drop the merge modal')).toBe('refactor/drop-merge-modal')
  })

  test('a scope is dropped — three levels reads as a directory', () => {
    expect(branchNameFromSubject('feat(api): add oauth callback')).toBe('feat/add-oauth-callback')
  })

  test('anything else slugs flat', () => {
    expect(branchNameFromSubject('Add the oauth callback')).toBe('add-oauth-callback')
    expect(branchNameFromSubject('wip')).toBe('wip')
  })

  // A subject describing two changes named neither: five words landed
  // mid-clause on "…picker's two" and stopped
  test('names the first change rather than half of both', () => {
    expect(branchNameFromSubject("feat: label base picker's two modes, drop default's local twin"))
      .toBe('feat/label-base-pickers-two-modes')
    expect(branchNameFromSubject('fix: settle running chips on interrupt; stop the clock'))
      .toBe('fix/settle-running-chips-interrupt')
  })

  // A clause that says nothing alone is worse than the whole subject
  test('keeps the whole subject when the first clause is one word', () => {
    expect(branchNameFromSubject('feat: nulls, empty strings and undefined'))
      .toBe('feat/nulls-empty-strings-undefined')
  })

  // `feat/` is not a branch name — a type with nothing sluggable after it
  // falls back to slugging the whole subject
  test('never emits a bare prefix with an empty name', () => {
    expect(branchNameFromSubject('chore: ---')).toBe('chore')
    expect(branchNameFromSubject('')).toBe('')
  })
})
