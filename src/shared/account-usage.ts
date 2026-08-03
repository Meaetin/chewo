/**
 * How much of a rate-limit window the account has spent.
 *
 * Deliberately separate from `ChatUsage`, which is per pane and comes off the
 * chat stream. These figures are account-wide and come from somewhere else
 * entirely — an authenticated call main makes (`claude-usage.ts`) — because the
 * stream carries no percentage at all: `rate_limit_event` reports a status and
 * a reset time and nothing more. Every pane shows the same numbers.
 *
 * Renderer-safe: no node imports in this file.
 */

/** The window names the CLI knows. Anything new is passed through untouched —
 *  the set is server-side and a window we cannot label still binds the user. */
export const RATE_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included'
] as const

export interface RateWindow {
  /** e.g. `five_hour` */
  type: string
  /** Percent of the window spent, 0–100 as reported */
  used: number
  /** Unix seconds, when the response gave one */
  resetsAt?: number
}

export interface AccountUsage {
  windows: RateWindow[]
  /** When this was read, unix ms — the readout is a cached figure, not live */
  fetchedAt: number
}

/**
 * Pull the windows out of the usage response.
 *
 * The endpoint is undocumented, so the shape is treated as a suggestion: this
 * walks the whole payload for objects keyed by a window name that carry a
 * numeric utilization, rather than reaching for a fixed path that a future
 * response could rename around. `utilization` is a percentage; `resets_at` is
 * either unix seconds or an ISO string depending on where it appears.
 */
export function parseAccountUsage(payload: unknown, fetchedAt: number): AccountUsage {
  const windows = new Map<string, RateWindow>()

  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entry = value as Record<string, unknown>
        const used = percent(entry.utilization ?? entry.percent)
        // Keyed by a window name *and* carrying a number: either alone is not
        // enough to call something a rate-limit window
        if (used !== undefined && looksLikeWindow(key) && !windows.has(key))
          windows.set(key, { type: key, used, resetsAt: epochSeconds(entry.resets_at) })
      }
      visit(value, depth + 1)
    }
  }
  visit(payload, 0)

  return { windows: [...windows.values()], fetchedAt }
}

/** A known name, or anything that reads like one — `thirty_day` should survive
 *  a server-side addition rather than be silently dropped. */
function looksLikeWindow(key: string): boolean {
  return (
    (RATE_WINDOWS as readonly string[]).includes(key) ||
    /^(one|five|seven|thirty)?_?\d*_?(hour|day|week|month)/.test(key)
  )
}

function percent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // A fraction is still a percentage of something; 0–1 responses would
  // otherwise render as "0% used" for a nearly spent window
  const n = value > 0 && value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, n))
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    return value > 1e11 ? Math.round(value / 1000) : Math.round(value)
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return Math.round(ms / 1000)
  }
  return undefined
}
