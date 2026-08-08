import { describe, expect, test } from 'vitest'
import { willCutBranch } from '../src/shared/ship-route'

/**
 * The one rule that differs between the two ways work leaves a checkout, and
 * the reason it is shared: `git-ship.ts` acts on it and `ShipModal` announces
 * it, so the two must never disagree about whether a branch is about to exist.
 */
describe('willCutBranch', () => {
  describe('opening a pull request', () => {
    test('a session branch ships as itself', () => {
      expect(willCutBranch('pr', 'agent/fix-login', 'dev/updates', 'main')).toBe(false)
    })

    test('shipping from the repo default cuts a branch first', () => {
      expect(willCutBranch('pr', 'main', 'main', 'main')).toBe(true)
    })

    // Retargeting at `develop` while standing on `main` still has to branch —
    // the commits were never meant for the shared checkout's branch
    test('the repo default is protected whatever the target is', () => {
      expect(willCutBranch('pr', 'main', 'develop', 'main')).toBe(true)
    })

    test('a PR from a branch into itself is not a thing, so it branches', () => {
      expect(willCutBranch('pr', 'dev/updates', 'dev/updates', 'main')).toBe(true)
    })
  })

  describe('pushing straight onto the base', () => {
    test('a session branch pushes its commits without branching', () => {
      expect(willCutBranch('push', 'agent/fix-login', 'dev/updates', 'main')).toBe(false)
    })

    // The inversion: adding to the base is the point, so standing on it is no
    // reason to branch — and cutting one would land the commits on the remote
    // while leaving the local branch behind them
    test('standing on the branch being pushed to is not a reason to branch', () => {
      expect(willCutBranch('push', 'dev/updates', 'dev/updates', 'main')).toBe(false)
      expect(willCutBranch('push', 'main', 'main', 'main')).toBe(false)
    })

    test('but the repo default is still protected from a push aimed elsewhere', () => {
      expect(willCutBranch('push', 'main', 'dev/updates', 'main')).toBe(true)
    })
  })
})
