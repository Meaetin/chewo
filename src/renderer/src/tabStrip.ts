/**
 * Overflow state of the session tab strip (the `.terminal-tabs` scrollport).
 *
 * Split out DOM-free so it can be tested, the same way `selectPlacement.ts`
 * holds the Select menu's geometry. The strip shrinks its tabs to a floor and
 * only then scrolls; past that point the user has to be *told* there is more,
 * because a horizontally scrolled strip with no scrollbar (we hide it) looks
 * exactly like a strip that ends there.
 */

export interface StripMetrics {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export interface StripEdges {
  /** Tabs are cut off to the left — fade that edge */
  left: boolean
  /** Tabs are cut off to the right — fade that edge */
  right: boolean
  /** Anything hidden at all: what the ⌄ overflow button keys off */
  overflowing: boolean
}

/**
 * Sub-pixel slack. Layout widths are fractional and `scrollLeft` is not
 * clamped to an integer, so an exactly-scrolled-to-the-end strip routinely
 * reports a leftover fraction of a pixel — without the tolerance the right
 * fade never quite switches off.
 */
export const EDGE_EPSILON = 1

export function stripEdges({ scrollLeft, scrollWidth, clientWidth }: StripMetrics): StripEdges {
  const overflowing = scrollWidth - clientWidth > EDGE_EPSILON
  if (!overflowing) return { left: false, right: false, overflowing: false }
  return {
    left: scrollLeft > EDGE_EPSILON,
    right: scrollLeft + clientWidth < scrollWidth - EDGE_EPSILON,
    overflowing: true
  }
}
