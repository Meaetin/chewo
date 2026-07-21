/**
 * Single-quote a string for `/bin/zsh -c`.
 *
 * Everything inside single quotes is literal to the shell — no expansion, no
 * command substitution, newlines included — so the only character needing
 * care is the quote itself: close, escape one, reopen. This is the boundary
 * that keeps user-authored text (todo card titles, MCP server args) from
 * being executed, so there is exactly one implementation of it.
 */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
