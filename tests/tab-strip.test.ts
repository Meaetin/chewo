import { describe, expect, test } from 'vitest'
import { stripEdges } from '../src/renderer/src/tabStrip'

/**
 * Which edges of the session tab strip are hiding tabs. The bug this exists
 * for: with four sessions open the leftmost tab was clipped flat against the
 * git toggle with no fade and no affordance, so a strip that scrolled looked
 * like a strip that ended.
 */

describe('stripEdges', () => {
  test('nothing hidden when the tabs fit', () => {
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 900 })).toEqual({
      left: false,
      right: false,
      overflowing: false
    })
  })

  test('scrolled to the start hides only the right', () => {
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 1400, clientWidth: 900 })).toEqual({
      left: false,
      right: true,
      overflowing: true
    })
  })

  test('mid-scroll hides both edges', () => {
    expect(stripEdges({ scrollLeft: 200, scrollWidth: 1400, clientWidth: 900 })).toEqual({
      left: true,
      right: true,
      overflowing: true
    })
  })

  test('scrolled to the end hides only the left', () => {
    expect(stripEdges({ scrollLeft: 500, scrollWidth: 1400, clientWidth: 900 })).toEqual({
      left: true,
      right: false,
      overflowing: true
    })
  })

  // Fractional layout widths leave a sliver at the end of the scroll; without
  // the tolerance the right-hand fade would never switch off.
  test('a sub-pixel remainder does not count as hidden', () => {
    expect(stripEdges({ scrollLeft: 500.4, scrollWidth: 1400.6, clientWidth: 900 })).toEqual({
      left: true,
      right: false,
      overflowing: true
    })
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 900.5, clientWidth: 900 }).overflowing).toBe(
      false
    )
  })
})
