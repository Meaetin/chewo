import { describe, expect, test } from 'vitest'
import { MENU_MAX_HEIGHT, placeMenu, type TriggerBox } from '../src/renderer/src/selectPlacement'

/**
 * Where the Select menu lands. The case that made this a rule: the chat
 * composer's setup row sits at the bottom of the window, so a menu pinned
 * below its trigger was clamped to a few pixels and read as "the dropdown
 * shows nothing".
 */

const view = { width: 1200, height: 800 }
const trigger = (top: number, extra: Partial<TriggerBox> = {}): TriggerBox => ({
  top,
  bottom: top + 24,
  left: 400,
  width: 90,
  ...extra
})

describe('placeMenu', () => {
  test('opens below a trigger with room under it', () => {
    const p = placeMenu(trigger(120), 0, view)
    expect(p.up).toBe(false)
    expect(p.top).toBe(148)
    expect(p.bottom).toBeUndefined()
    expect(p.maxHeight).toBe(MENU_MAX_HEIGHT)
  })

  test('flips above a trigger at the bottom of the window', () => {
    const p = placeMenu(trigger(760), 0, view)
    expect(p.up).toBe(true)
    // Anchored by its own bottom edge, just above the trigger's top
    expect(p.bottom).toBe(view.height - 760 + 4)
    expect(p.top).toBeUndefined()
    expect(p.maxHeight).toBe(MENU_MAX_HEIGHT)
  })

  test('never renders an unusable sliver — the old bug', () => {
    // A trigger 8px off the bottom: below it there is nothing to clamp to
    const p = placeMenu(trigger(768), 0, view)
    expect(p.up).toBe(true)
    expect(p.maxHeight).toBeGreaterThan(200)
  })

  test('stays below when neither side fits but below is roomier', () => {
    const p = placeMenu(trigger(40), 0, { width: 1200, height: 400 })
    expect(p.up).toBe(false)
    expect(p.maxHeight).toBeGreaterThan(0)
  })

  test('honours the width floor and keeps the menu off the right edge', () => {
    const p = placeMenu(trigger(120, { left: 1100 }), 260, view)
    expect(p.width).toBe(260)
    expect(p.left).toBe(view.width - 260 - 12)
  })

  test('a menu wider than the window is pinned to the left margin, not negative', () => {
    const p = placeMenu(trigger(120, { left: 20 }), 400, { width: 300, height: 800 })
    expect(p.left).toBe(12)
  })
})
