/**
 * Joining spoken words onto typed ones. DOM-free and tested, like
 * `elapsed.ts` and `tabStrip.ts` next to it.
 */

/**
 * Put dictated words after whatever was already in the composer.
 *
 * Pressing the mic must not cost a half-written message, so the two are joined
 * rather than swapped. The space is added only when it is missing, and never
 * after a newline — a message part-written as a list keeps its shape when the
 * rest of it is spoken.
 */
export function joinDictated(base: string, dictated: string): string {
  if (!base) return dictated
  if (!dictated) return base
  return /\s$/.test(base) ? base + dictated : `${base} ${dictated}`
}
