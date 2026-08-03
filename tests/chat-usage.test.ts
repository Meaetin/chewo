import { describe, expect, test } from 'vitest'
import { usageChips } from '../src/renderer/src/chatUsage'
import { parseAccountUsage, type AccountUsage } from '../src/shared/account-usage'

/**
 * The line under the composer. Its one rule is that it never states a number
 * nobody gave us: the rate-limit percentages come from the account call, and
 * when that call comes back empty the chip names the window instead of
 * guessing how much of it is left.
 */

// Local, not UTC: the readout is rendered in the user's own timezone, so a
// UTC fixture would land on a different calendar day east of Greenwich and
// the "resets today" branch would flip under the test.
const NOW = new Date(2026, 7, 3, 12, 0, 0).getTime()
const RESETS = Math.floor(new Date(2026, 7, 3, 16, 50, 0).getTime() / 1000)
const NEXT_WEEK = Math.floor(new Date(2026, 7, 7, 9, 0, 0).getTime() / 1000)

const account = (windows: AccountUsage['windows']): AccountUsage => ({ windows, fetchedAt: NOW })

describe('context chip', () => {
  test('says nothing at all before the first turn', () => {
    expect(usageChips({}, null, NOW)).toEqual([])
  })

  test('counts tokens while the window size is still unknown', () => {
    // `contextWindow` only arrives with the turn's `result`, so the first
    // assistant message of a fresh pane has a numerator and no denominator
    const [chip] = usageChips({ contextTokens: 33093 }, null, NOW)
    expect(chip.text).toBe('Context 33k')
    expect(chip.fill).toBeUndefined()
    expect(chip.tone).toBe('dim')
  })

  test('becomes a percentage once the window is known', () => {
    const [chip] = usageChips({ contextTokens: 32593, contextWindow: 200000 }, null, NOW)
    expect(chip.text).toBe('Context 16%')
    expect(chip.fill).toBeCloseTo(0.163)
    expect(chip.title).toBe('32,593 of 200,000 tokens in the context window')
  })

  test('warns before it is too late to act, and shouts at the end', () => {
    expect(usageChips({ contextTokens: 160000, contextWindow: 200000 }, null, NOW)[0].tone).toBe('warning')
    expect(usageChips({ contextTokens: 185000, contextWindow: 200000 }, null, NOW)[0].tone).toBe('danger')
  })

  test('a window overrun still draws a full bar, never a wider one', () => {
    expect(usageChips({ contextTokens: 260000, contextWindow: 200000 }, null, NOW)[0].fill).toBe(1)
  })
})

describe('rate-limit chips', () => {
  test('reads as a percentage used and a reset time', () => {
    const chips = usageChips(
      {},
      account([
        { type: 'five_hour', used: 98, resetsAt: RESETS },
        { type: 'seven_day', used: 42, resetsAt: NEXT_WEEK }
      ]),
      NOW
    )
    // Time formatting is the platform's; what this pins is the wording and
    // that a reset later today is stated as a bare time
    expect(chips[0].text).toMatch(/^5h 98% used, resets \d/)
    expect(chips[0].tone).toBe('danger')
    // A reset days out carries its day, or it reads as tonight
    expect(chips[1].text).toMatch(/^Week 42% used, resets \w{3} /)
    expect(chips[1].tone).toBe('dim')
  })

  test('the 5h figure never swaps places with the weekly one', () => {
    // The line sits under the cursor while the user types; two figures trading
    // positions between polls is unreadable
    const chips = usageChips(
      {},
      account([
        { type: 'seven_day', used: 42 },
        { type: 'five_hour', used: 12 }
      ]),
      NOW
    )
    expect(chips.map((c) => c.id)).toEqual(['limit:five_hour', 'limit:seven_day'])
  })

  test('a per-model weekly window shows up only when it is nearly spent', () => {
    const quiet = usageChips({}, account([{ type: 'seven_day_opus', used: 20 }]), NOW)
    expect(quiet).toEqual([])

    const loud = usageChips({}, account([{ type: 'seven_day_opus', used: 91 }]), NOW)
    expect(loud[0].text).toBe('Week · Opus 91% used')
    expect(loud[0].tone).toBe('danger')
  })

  test('with no percentages it names the window instead of inventing one', () => {
    // The stream knows which window binds and when it rolls over, and that the
    // CLI has started warning — but never how much is left
    const [chip] = usageChips(
      { limitType: 'five_hour', limitStatus: 'allowed_warning', limitResetsAt: RESETS },
      null,
      NOW
    )
    expect(chip.text).toMatch(/^5h limit nearly used, resets \d/)
    expect(chip.tone).toBe('warning')
    expect(chip.title).toContain('percentage is unavailable')
  })

  test('a real percentage outranks the stream’s vaguer signal', () => {
    const chips = usageChips(
      { limitType: 'five_hour', limitStatus: 'allowed_warning', limitResetsAt: RESETS },
      account([{ type: 'five_hour', used: 88, resetsAt: RESETS }]),
      NOW
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].text).toMatch(/^5h 88% used, resets \d/)
  })
})

describe('usage payload parsing', () => {
  // The endpoint is undocumented, so the parser is written to survive being
  // wrong about the shape rather than to match one exactly.
  test('reads windows wherever they sit in the payload', () => {
    const parsed = parseAccountUsage(
      { usage: { five_hour: { utilization: 98, resets_at: RESETS } } },
      NOW
    )
    expect(parsed.windows).toEqual([{ type: 'five_hour', used: 98, resetsAt: RESETS }])
  })

  test('accepts an ISO reset and a fractional utilization', () => {
    const parsed = parseAccountUsage(
      { seven_day: { utilization: 0.42, resets_at: '2026-08-07T09:00:00Z' } },
      NOW
    )
    expect(parsed.windows[0].used).toBeCloseTo(42)
    expect(parsed.windows[0].resetsAt).toBe(Math.floor(Date.parse('2026-08-07T09:00:00Z') / 1000))
  })

  test('a window name we have never seen is still reported', () => {
    const parsed = parseAccountUsage({ thirty_day: { utilization: 10 } }, NOW)
    expect(parsed.windows.map((w) => w.type)).toEqual(['thirty_day'])
  })

  test('a payload with nothing recognisable yields no windows, not zeroes', () => {
    // Which is what makes a shape change read as "unavailable" rather than as
    // "you have used 0% of everything"
    expect(parseAccountUsage({ ok: true, limits: [] }, NOW).windows).toEqual([])
    expect(parseAccountUsage(null, NOW).windows).toEqual([])
  })
})
