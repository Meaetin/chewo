import { describe, expect, test } from 'vitest'
import {
  DEFAULT_WORKTREE_SETTINGS,
  normalizeWorktreeSettings
} from '../src/shared/worktree-settings'

/**
 * The one thing this normalizer must never do is turn a deliberate "off" into
 * the default "on": settings files written before this key existed and files
 * where the user unticked the box are both "no `true` here", and only the
 * second one has an opinion. Reading the stored value as a boolean rather than
 * for truthiness is what keeps them apart.
 */

describe('normalizeWorktreeSettings', () => {
  test('a settings file from before the key existed gets the default', () => {
    expect(normalizeWorktreeSettings(undefined)).toEqual(DEFAULT_WORKTREE_SETTINGS)
    expect(normalizeWorktreeSettings({})).toEqual(DEFAULT_WORKTREE_SETTINGS)
  })

  test('cleanup is on by default — a merge from the modal is explicit enough', () => {
    expect(DEFAULT_WORKTREE_SETTINGS.autoCleanupOnMerge).toBe(true)
  })

  test('a stored false survives, and is never re-defaulted to on', () => {
    expect(normalizeWorktreeSettings({ autoCleanupOnMerge: false })).toEqual({
      autoCleanupOnMerge: false
    })
  })

  test('a stored true round-trips', () => {
    expect(normalizeWorktreeSettings({ autoCleanupOnMerge: true })).toEqual({
      autoCleanupOnMerge: true
    })
  })

  // Hand-edited settings.json, or a key that changed shape between versions.
  test('a non-boolean is not trusted as a choice', () => {
    const junk = { autoCleanupOnMerge: 'false' } as unknown as { autoCleanupOnMerge: boolean }
    expect(normalizeWorktreeSettings(junk)).toEqual(DEFAULT_WORKTREE_SETTINGS)
  })
})
