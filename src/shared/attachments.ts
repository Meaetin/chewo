/**
 * Composer attachments: what a paste turns into when it is too big to sit in
 * the text box.
 *
 * Two kinds, for two different reasons.
 *
 *   image  Never had a textual form to begin with. Staged to a real file under
 *          ~/.chewo/attachments the moment it is pasted, because the four ways
 *          a message can reach an agent do not agree on how to carry pixels: a
 *          chat pane inlines base64 content blocks, a codex pty takes `-i
 *          <file>`, a claude pty reads a path out of the prompt. A file is the
 *          one representation all three can be derived from.
 *
 *   text   A stack trace or a log dump would drown the composer and hide the
 *          sentence the user is actually writing. It is folded back into the
 *          message verbatim on send, so the agent sees exactly what was on the
 *          clipboard — the chip is a display device, not a transformation.
 *
 * The threshold is deliberately generous: a paragraph should paste as a
 * paragraph. Only something that would push the typed message off screen earns
 * a chip.
 */

export interface Attachment {
  id: string
  kind: 'image' | 'text'
  /** Chip label — "Screenshot 1", "Pasted text 2" */
  label: string
  /** image: absolute path of the staged file */
  path?: string
  /** image: data URL, for the chip thumbnail. Renderer-only, never sent. */
  preview?: string
  /** text: the clipboard contents, verbatim */
  text?: string
  /** text: line count, shown on the chip */
  lines?: number
}

/** What the sent bubble echoes back — the chip without its payload. */
export type AttachmentChip = Pick<Attachment, 'id' | 'kind' | 'label' | 'preview' | 'lines'>

export const PASTE_MIN_LINES = 12
export const PASTE_MIN_CHARS = 1200

/** Big enough that inlining it would bury the message being written. */
export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || text.split('\n').length >= PASTE_MIN_LINES
}

export const countLines = (text: string): number => text.split('\n').length

export const chipOf = (a: Attachment): AttachmentChip => ({
  id: a.id,
  kind: a.kind,
  label: a.label,
  preview: a.preview,
  lines: a.lines
})

/**
 * The message the agent receives: what was typed, then each pasted block
 * fenced in a tag so the model can tell the quoted dump from the request
 * around it. Images are not mentioned here — they ride as content blocks or
 * as CLI flags, depending on the runtime (see `withImagePaths`).
 */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = text.trim() ? [text.trim()] : []
  for (const a of attachments) {
    if (a.kind !== 'text' || !a.text) continue
    parts.push(`<pasted label="${a.label}">\n${a.text}\n</pasted>`)
  }
  return parts.join('\n\n')
}

const PASTED_BLOCK = /\n*<pasted label="([^"]*)">\n([\s\S]*?)\n<\/pasted>/g

/**
 * Inverse of `composeMessage`, for a pane handed a prompt another composer
 * already built — the replacement pane a first message creates.
 *
 * Without it that pane's bubble would render the whole folded-in log, which is
 * precisely what the chip exists to avoid. The agent's copy is untouched; this
 * only decides what the transcript shows.
 */
export function splitComposed(message: string): { display: string; chips: AttachmentChip[] } {
  const chips: AttachmentChip[] = []
  const display = message
    .replace(PASTED_BLOCK, (_full, label: string, body: string) => {
      chips.push({ id: `pasted-${chips.length}`, kind: 'text', label, lines: countLines(body) })
      return ''
    })
    .trim()
  return { display, chips }
}

/**
 * Claude's pty path only: it reads image *paths* it finds in a prompt, so the
 * files have to be named. The chat pane and codex both carry the bytes
 * themselves and must not get this.
 */
export function withImagePaths(message: string, paths: string[]): string {
  if (paths.length === 0) return message
  const block = ['Attached images (read these files):', ...paths.map((p) => `- ${p}`)].join('\n')
  return message ? `${message}\n\n${block}` : block
}

/** Chips for a pane that was handed staged files rather than a live paste. */
export function chipsForPaths(paths: string[]): AttachmentChip[] {
  return paths.map((path, i) => ({
    id: path,
    kind: 'image' as const,
    label: `Image ${i + 1}`
  }))
}
