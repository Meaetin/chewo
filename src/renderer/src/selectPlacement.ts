/**
 * Placement for the `Select` menu (src/renderer/src/components/Select.tsx).
 *
 * Split out so it can be tested without a DOM, the same way `selectFilter.ts`
 * holds the filtering rule.
 */

export interface TriggerBox {
  top: number
  bottom: number
  left: number
  width: number
}

export interface Viewport {
  width: number
  height: number
}

export interface MenuPlacement {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
  up: boolean
}

export const MENU_GAP = 4
export const MENU_MAX_HEIGHT = 260
/** Keep the menu off the window edges it would otherwise sit flush against. */
export const VIEWPORT_MARGIN = 12

/**
 * Below the trigger is the default, but a trigger near the bottom of the
 * window — the chat composer's setup row lives there permanently — has no room
 * there, and a menu clamped to what is left renders as an invisible sliver.
 * So flip above whenever that side is roomier, and anchor it by its own bottom
 * edge so it grows upwards away from the trigger.
 */
export function placeMenu(trigger: TriggerBox, minWidth: number, view: Viewport): MenuPlacement {
  const below = view.height - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN
  const above = trigger.top - MENU_GAP - VIEWPORT_MARGIN
  const up = below < MENU_MAX_HEIGHT && above > below
  const width = Math.max(trigger.width, minWidth)
  return {
    ...(up
      ? { bottom: view.height - trigger.top + MENU_GAP }
      : { top: trigger.bottom + MENU_GAP }),
    // A menu widened past its trigger can overhang the right edge, which clips
    // it just as effectively as running off the bottom.
    left: Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, view.width - width - VIEWPORT_MARGIN)),
    width,
    maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(up ? above : below, 0)),
    up
  }
}
