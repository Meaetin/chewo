import { useEffect, useRef, useState } from 'react'
import type { AccountUsage } from '../../../../shared/account-usage'

/**
 * The account's rate-limit percentages, for the composer's readout.
 *
 * Every pane calls this and they all get the same answer: main caches for a
 * minute and collapses concurrent asks into one request, so the cost of a
 * dozen open panes is the same as one. That is why this is a plain hook rather
 * than a store threaded down from App — there is nothing to coordinate.
 *
 * It asks at three moments and no others, because a rate-limit window moves
 * only when you spend it:
 *   - on mount, so a pane opens with a figure
 *   - when a turn ends (`busy` falling), forced past the cache — the one
 *     moment the numbers are known to have changed
 *   - when the window regains focus, for the hours the app sat in the
 *     background
 */
export function useAccountUsage(busy: boolean): AccountUsage | null {
  const [usage, setUsage] = useState<AccountUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (force: boolean): void => {
      void window.api
        .accountUsage(force)
        .then((next) => {
          // Keep the last good figure rather than blanking the line on one bad
          // read — a dropped connection is not "you have used 0%"
          if (!cancelled && next) setUsage(next)
        })
        .catch(() => undefined)
    }

    read(false)
    const onFocus = (): void => read(false)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Only the falling edge: a turn just finished, so the window it spent has
  // moved. Guarded on having actually been busy, or every pane would force a
  // request past the cache the moment it mounted.
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      return
    }
    if (!wasBusy.current) return
    wasBusy.current = false
    let cancelled = false
    void window.api
      .accountUsage(true)
      .then((next) => {
        if (!cancelled && next) setUsage(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [busy])

  return usage
}
