import { useEffect, useRef, useState } from 'react'

/**
 * Even out the CLI's streaming cadence.
 *
 * Text arrives from the model in bursts — often a whole clause at a time, then
 * a pause — which reads as stuttering rather than typing. This buffers the
 * incoming text and reveals it a few characters per frame, so the visible rate
 * is smooth even though the arrival rate is lumpy.
 *
 * It is a *smoother*, not a throttle: the reveal speed is derived from how far
 * behind it is, so it always catches up and never becomes the bottleneck. A
 * large backlog drains proportionally faster, and once the block is complete
 * the remainder is flushed harder still — so the last words of a reply are
 * never left trickling after the agent has finished.
 */

/** Frames are ~16ms; dividing the backlog spreads it over roughly this many. */
const CATCHUP_FRAMES = 14
/** Once the source says it is done, drain this much more aggressively. */
const FINISHED_FRAMES = 5
/** Never crawl — guarantees progress even one character from the end. */
const MIN_CHARS_PER_FRAME = 2

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Chromium throttles (and eventually pauses) rAF for an occluded or hidden
 * window, which would leave revealed text stuck behind the real text until the
 * window came back. Nobody is watching an animation they cannot see, so when
 * the page is not visible the text is shown in full immediately.
 */
const canAnimate = (): boolean =>
  !prefersReducedMotion() &&
  (typeof document === 'undefined' || document.visibilityState === 'visible')

export function useSmoothText(target: string, done: boolean): string {
  const [shown, setShown] = useState(() => (canAnimate() ? '' : target))
  const frameRef = useRef<number | null>(null)
  const shownRef = useRef(shown.length)
  // Re-runs the effect when the window is hidden or restored
  const [visibleTick, setVisibleTick] = useState(0)

  useEffect(() => {
    const onVisibility = (): void => setVisibleTick((t) => t + 1)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!canAnimate()) {
      shownRef.current = target.length
      setShown(target)
      return
    }

    // A shorter target means a different block reused this hook — restart
    // rather than hold a stale, longer string.
    if (target.length < shownRef.current) {
      shownRef.current = 0
      setShown('')
    }

    const step = (): void => {
      frameRef.current = null
      const backlog = target.length - shownRef.current
      if (backlog <= 0) return

      const spread = done ? FINISHED_FRAMES : CATCHUP_FRAMES
      const advance = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / spread))
      shownRef.current = Math.min(target.length, shownRef.current + advance)
      setShown(target.slice(0, shownRef.current))

      if (shownRef.current < target.length) frameRef.current = requestAnimationFrame(step)
    }

    if (shownRef.current < target.length && frameRef.current === null)
      frameRef.current = requestAnimationFrame(step)

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [target, done, visibleTick])

  return shown
}
