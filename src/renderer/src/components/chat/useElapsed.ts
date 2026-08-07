import { useEffect, useState } from 'react'
import { formatElapsed } from '../../elapsed'

/**
 * How long the current turn has been running, as a label for the working line.
 *
 * "Working…" alone cannot distinguish three seconds from four minutes, which is
 * the difference between waiting and wondering whether the CLI has hung.
 *
 * The clock only ticks while the pane is on screen. Every `ChatPane` stays
 * mounted and is hidden with `display: none`, so a 1 Hz timer in each one would
 * re-render every conversation in the window once a second for a number nobody
 * can see — and the reading is derived from a start stamp rather than counted,
 * so a pane returning from hidden is immediately right rather than resuming
 * from wherever it was when it left.
 */
export function useElapsed(running: boolean, active: boolean): string | null {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [, tick] = useState(0)

  useEffect(() => setStartedAt(running ? Date.now() : null), [running])

  useEffect(() => {
    if (!running || !active) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running, active])

  // Null for the render between the turn starting and the effect stamping it,
  // which the working line shows as a plain "Working…" — the same thing it
  // showed before there was a clock at all.
  if (!running || startedAt === null) return null
  return formatElapsed(Date.now() - startedAt)
}
