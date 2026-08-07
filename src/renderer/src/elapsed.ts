/**
 * Below a minute the seconds are the reading; above it, minutes are, and the
 * seconds only keep the number from looking frozen. Nothing here is a duration
 * anyone does arithmetic on, so it never grows an hours field — a turn that
 * runs past an hour reads as "83:20" and that is honest enough.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
