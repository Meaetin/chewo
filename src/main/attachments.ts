import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Staged clipboard images (SPEC §chat). A pasted image lands here as a real
 * file before it is ever sent, because the runtimes disagree about how to
 * carry one — see the header of `shared/attachments.ts`.
 *
 * Deliberately outside every project checkout: an image pasted into a session
 * must not show up in `git status` and get swept into a Ship. It sits beside
 * the todo boards and the worktrees under ~/.chewo, which the sidebar already
 * filters out of the session list.
 */
export const ATTACHMENTS_DIR = join(homedir(), '.chewo', 'attachments')

/** Only what a clipboard actually produces; anything else is refused. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** Files older than this are swept at launch — a sent image is history. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** Write a base64 clipboard image to disk. Returns its absolute path. */
export function stageImage(base64: string, mimeType: string): string {
  const ext = EXTENSIONS[mimeType]
  if (!ext) throw new Error(`Unsupported image type: ${mimeType}`)
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
  const path = join(ATTACHMENTS_DIR, `${randomUUID()}.${ext}`)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  return path
}

/**
 * A staged file as an Anthropic image content block. Verified 2026-08-03
 * against CLI 2.1.220: `--input-format stream-json` accepts a content *array*
 * on a user message and the model genuinely sees the pixels (it named the
 * colour of a solid-red probe image), so a chat pane needs no `--add-dir` and
 * no Read tool call to look at a screenshot.
 *
 * Anything unreadable is dropped rather than thrown: a missing staged file
 * must not swallow the sentence it was attached to.
 */
export function imageBlocks(paths: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const raw of paths) {
    // Only ever a file sitting directly in our own staging directory. Resolved
    // and compared by *parent*, not by prefix: the renderer hands these back
    // and a prefix test would accept `<dir>/../../.ssh/id_rsa`.
    const path = resolve(raw)
    if (dirname(path) !== ATTACHMENTS_DIR) continue
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const mediaType = Object.entries(EXTENSIONS).find(([, e]) => e === ext)?.[0]
    if (!mediaType) continue
    try {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: readFileSync(path).toString('base64') }
      })
    } catch {
      continue
    }
  }
  return blocks
}

/** Drop staged images the app has finished with. Called once, at launch. */
export function pruneAttachments(): void {
  let names: string[]
  try {
    names = readdirSync(ATTACHMENTS_DIR)
  } catch {
    return
  }
  const cutoff = Date.now() - KEEP_MS
  for (const name of names) {
    const path = join(ATTACHMENTS_DIR, name)
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    } catch {
      continue
    }
  }
}
