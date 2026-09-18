/**
 * What a file dragged onto a chat pane becomes. DOM-free and tested, like
 * `mentionMatch.ts` next door.
 *
 * Two outcomes, and the split is forced by what the runtimes can carry. An
 * image has no textual form, so it goes down the same road a pasted
 * screenshot does: copied into `~/.chewo/attachments` and sent as pixels.
 * Anything else — a PDF, a log, a source file, a folder — is named in the
 * message instead, and the agent reads it with its own Read tool. Copying a
 * 40 MB PDF through base64 IPC to inline into a prompt no runtime accepts
 * would be work for nothing.
 *
 * Only the four types `stageImage` can actually write count as images. A HEIC
 * or an SVG is refused by main, so it is named as a path rather than staged
 * and then reported as a failure.
 */

const STAGEABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isStageableImage = (mimeType: string): boolean =>
  STAGEABLE.has(mimeType.toLowerCase())

/**
 * The text to write into the message for a dropped file.
 *
 * Relative to the checkout when the file is inside it, which is both shorter
 * to read and what the `@`-mention picker inserts. The comparison carries the
 * trailing separator, so a sibling directory (`/repo-other`) can never match
 * `/repo` by prefix.
 *
 * A path with a space in it is backticked: dropped from Finder these are
 * common, and a bare one reads as two arguments in the middle of a sentence.
 * No `@` prefix — that character is the picker's trigger, and an absolute
 * path wearing it means something different to each CLI.
 */
export function dropText(absPath: string, cwd?: string): string {
  const path = relativeTo(absPath, cwd)
  return path.includes(' ') ? `\`${path}\`` : path
}

function relativeTo(absPath: string, cwd?: string): string {
  if (!cwd) return absPath
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return absPath.startsWith(base) ? absPath.slice(base.length) : absPath
}

/**
 * Where an insertion goes when the box was never focused — the end, not the
 * caret, which is still sitting at 0 from before anything was typed.
 */
export function insertAt(value: string, caret: number, focused: boolean): number {
  return focused ? Math.min(caret, value.length) : value.length
}

/** Splice `text` in as its own word, with a trailing space to type after. */
export function spliceWord(value: string, at: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, at)
  const after = value.slice(at)
  const pad = before && !/\s$/.test(before) ? ' ' : ''
  const caret = before.length + pad.length + text.length + 1
  return { value: `${before}${pad}${text} ${after}`, caret }
}
