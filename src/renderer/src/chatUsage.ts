import type { AccountUsage } from '../../shared/account-usage'
import type { ChatUsage } from '../../shared/agent-chat'

/**
 * The readout under the composer: how full the context window is, and how much
 * of each rate-limit window the account has spent.
 *
 * Pure so it can be tested without a DOM, and so `now` is an argument rather
 * than a clock — reset times are rendered absolutely precisely so nothing here
 * has to tick.
 *
 * The two halves come from different places and fail independently. Context is
 * on the chat stream and is always available once a turn has run. Percentages
 * are *not* on the stream at all — they come from the account call in
 * `claude-usage.ts`, which can come back empty — so when they are missing the
 * limit chip falls back to naming the window and its reset. It never guesses a
 * percentage: a number on screen is read as measured.
 */

export interface UsageChip {
  id: string
  text: string
  title: string
  /** 0–1, for the bar drawn behind the text. Absent when there is no denominator. */
  fill?: number
  tone: 'dim' | 'warning' | 'danger'
}

/** The CLI's own window names. Anything unknown is printed as it arrives —
 *  the set grows server-side, and a new one is still worth showing. */
const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  seven_day_opus: 'Week · Opus',
  seven_day_sonnet: 'Week · Sonnet',
  seven_day_overage_included: 'Week · overage'
}

/** Always shown when known, in this order — they are the two budgets the user
 *  asked about. Others appear only when they are close enough to matter. */
const ALWAYS_SHOWN = ['five_hour', 'seven_day']
const NOTEWORTHY = 75

const label = (type: string): string => LIMIT_LABELS[type] ?? type.replace(/_/g, ' ')

const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

const toneFor = (fraction: number): UsageChip['tone'] =>
  fraction >= 0.9 ? 'danger' : fraction >= 0.75 ? 'warning' : 'dim'

/**
 * A reset later today is a time; anything further out needs the day, because
 * the weekly windows are days away and "resets 09:00" alone reads as tomorrow
 * morning at the latest.
 */
function resetLabel(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

export function usageChips(
  usage: ChatUsage,
  account: AccountUsage | null,
  now = Date.now()
): UsageChip[] {
  const chips: UsageChip[] = []
  const clock = new Date(now)

  if (usage.contextTokens) {
    const used = usage.contextTokens
    const window = usage.contextWindow
    const fill = window ? Math.min(used / window, 1) : undefined
    chips.push({
      id: 'context',
      // Until a turn has finished there is no window to divide by, so the
      // count stands on its own rather than waiting for a percentage
      text: fill === undefined ? `Context ${compact(used)}` : `Context ${Math.round(fill * 100)}%`,
      title: window
        ? `${used.toLocaleString()} of ${window.toLocaleString()} tokens in the context window`
        : `${used.toLocaleString()} tokens in the context window`,
      fill,
      tone: fill === undefined ? 'dim' : toneFor(fill)
    })
  }

  const windows = (account?.windows ?? []).filter(
    (w) => ALWAYS_SHOWN.includes(w.type) || w.used >= NOTEWORTHY
  )
  // Fixed order, so the 5h figure does not swap places with the weekly one
  // between polls and make the line jump under the reader's eye
  windows.sort((a, b) => {
    const rank = (t: string): number =>
      ALWAYS_SHOWN.indexOf(t) === -1 ? ALWAYS_SHOWN.length : ALWAYS_SHOWN.indexOf(t)
    return rank(a.type) - rank(b.type) || a.type.localeCompare(b.type)
  })

  for (const window of windows) {
    const at = window.resetsAt ? new Date(window.resetsAt * 1000) : null
    const used = Math.round(window.used)
    chips.push({
      id: `limit:${window.type}`,
      text: `${label(window.type)} ${used}% used${at ? `, resets ${resetLabel(at, clock)}` : ''}`,
      title: at
        ? `${used}% of the ${label(window.type).toLowerCase()} rate-limit window used. It resets ${at.toLocaleString()}.`
        : `${used}% of the ${label(window.type).toLowerCase()} rate-limit window used.`,
      fill: window.used / 100,
      tone: toneFor(window.used / 100)
    })
  }

  // No percentages to be had. The stream still names whichever window is
  // binding and when it rolls over, which is worth more than an empty line —
  // and the CLI's own warning, which is the one thing it does tell us.
  if (windows.length === 0 && usage.limitType) {
    const at = usage.limitResetsAt ? new Date(usage.limitResetsAt * 1000) : null
    const resets = at ? resetLabel(at, clock) : null
    const state =
      usage.limitStatus === 'rejected'
        ? 'reached'
        : usage.limitStatus === 'allowed_warning'
          ? 'nearly used'
          : null
    chips.push({
      id: `limit:${usage.limitType}`,
      text: state
        ? `${label(usage.limitType)} limit ${state}${resets ? `, resets ${resets}` : ''}`
        : `${label(usage.limitType)} window${resets ? ` resets ${resets}` : ''}`,
      title: `${at ? `The ${label(usage.limitType).toLowerCase()} rate-limit window resets ${at.toLocaleString()}.` : `The ${label(usage.limitType).toLowerCase()} rate-limit window.`} The percentage is unavailable — Chewo could not read your Claude usage (signed out, or the endpoint did not answer).`,
      tone:
        usage.limitStatus === 'rejected'
          ? 'danger'
          : usage.limitStatus === 'allowed_warning'
            ? 'warning'
            : 'dim'
    })
  }

  return chips
}
