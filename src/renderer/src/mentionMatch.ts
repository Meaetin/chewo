/**
 * Finds an in-progress `@` mention ending at the caret, for the chat
 * composer's file picker. DOM-free and tested, same reason as
 * `selectPlacement.ts` and `tabStrip.ts`.
 */

export interface MentionMatch {
  /** Index of the `@` character itself, so the caller knows what to replace */
  start: number
  query: string
}

/**
 * The `@` nearest the caret, with no whitespace between it and the caret.
 * Anchored on whitespace or the start of the string just before the `@`, so
 * a stray `@` mid-word — an email address, `user@host` — never opens the
 * picker, and finishing a mention with a space closes it rather than
 * re-matching an earlier `@` in the message.
 */
export function mentionAt(value: string, caret: number): MentionMatch | null {
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const before = at > 0 ? upto[at - 1] : undefined
  if (before !== undefined && !/\s/.test(before)) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}
