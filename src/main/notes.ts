import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { clipboard, shell } from 'electron'
import {
  isValidFolderName,
  kebabCase,
  parseNote,
  serializeNote,
  type NoteMeta,
  type NoteSource,
  type NotesSubject,
  type NotesTopic,
  type NotesTree
} from '../shared/notes'

/**
 * Filesystem layer for the notes store (SPEC-NOTES.md §5). Same philosophy
 * as the session stores: disk is the only data source, full rescan on every
 * change, no cache. All paths from the renderer are validated to stay inside
 * the notes root.
 */

// ~/Documents rides iCloud Documents sync; installs that predate this default
// keep their existing ~/ChewoNotes.
const legacyRoot = join(homedir(), 'ChewoNotes')
export const DEFAULT_NOTES_ROOT = existsSync(legacyRoot)
  ? legacyRoot
  : join(homedir(), 'Documents', 'Chewo Notes')

let notesRoot = DEFAULT_NOTES_ROOT

export function setNotesRoot(root: string): void {
  notesRoot = root
}

export function getNotesRoot(): string {
  mkdirSync(notesRoot, { recursive: true })
  return notesRoot
}

function assertInsideRoot(path: string): string {
  const resolved = resolve(path)
  const root = resolve(getNotesRoot())
  if (resolved !== root && !resolved.startsWith(root + sep))
    throw new Error(`path outside notes root: ${path}`)
  return resolved
}

export interface NotesOpResult {
  ok: boolean
  error?: string
  /** Created file path (createNote), or the new path (renameNoteItem) */
  path?: string
}

const fail = (error: string): NotesOpResult => ({ ok: false, error })

function readNoteMeta(path: string, fileName: string): NoteMeta {
  let title = ''
  let date = ''
  let source: NoteMeta['source'] = 'typed'
  let status: NoteMeta['status'] = 'structured'
  try {
    const parsed = parseNote(readFileSync(path, 'utf8'))
    title = parsed.title ?? ''
    date = parsed.date ?? ''
    source = parsed.source ?? 'typed'
    status = parsed.status ?? 'structured'
  } catch {
    /* unreadable file still gets a row — title falls back to the filename */
  }
  if (!title)
    title = fileName.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '') || fileName
  if (!date) {
    try {
      date = statSync(path).mtime.toISOString()
    } catch {
      date = ''
    }
  }
  return { path, fileName, title, date, source, status }
}

const visibleDirs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))

export function scanNotes(): NotesTree {
  const root = getNotesRoot()
  const subjects: NotesSubject[] = visibleDirs(root).map((subjectName): NotesSubject => {
    const subjectPath = join(root, subjectName)
    const topics: NotesTopic[] = visibleDirs(subjectPath).map((topicName): NotesTopic => {
      const topicPath = join(subjectPath, topicName)
      const notes = readdirSync(topicPath, { withFileTypes: true })
        // .raw.md twins are the audit trail behind a structured note, not pages
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.raw.md'))
        .map((e) => readNoteMeta(join(topicPath, e.name), e.name))
        .sort((a, b) => b.date.localeCompare(a.date))
      return { name: topicName, path: topicPath, notes }
    })
    return { name: subjectName, path: subjectPath, topics }
  })
  return { root, subjects }
}

export function createSubject(name: string): NotesOpResult {
  if (!isValidFolderName(name)) return fail('Invalid name')
  try {
    mkdirSync(join(getNotesRoot(), name.trim()))
    return { ok: true }
  } catch (err) {
    return fail(
      (err as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'A subject with that name already exists'
        : String(err)
    )
  }
}

export function createTopic(subject: string, name: string): NotesOpResult {
  if (!isValidFolderName(name)) return fail('Invalid name')
  try {
    const subjectPath = assertInsideRoot(join(getNotesRoot(), subject))
    mkdirSync(join(subjectPath, name.trim()))
    return { ok: true }
  } catch (err) {
    return fail(
      (err as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'A topic with that name already exists'
        : String(err)
    )
  }
}

export interface CreateNoteArgs {
  subject: string
  topic: string
  title: string
  body?: string
  source?: NoteSource
}

export function createNote(args: CreateNoteArgs): NotesOpResult {
  const title = args.title.trim() || 'Untitled'
  try {
    const topicPath = assertInsideRoot(join(getNotesRoot(), args.subject, args.topic))
    const now = new Date()
    const datePrefix = now.toISOString().slice(0, 10)
    const base = `${datePrefix}-${kebabCase(title)}`
    let fileName = `${base}.md`
    for (let n = 2; ; n++) {
      try {
        statSync(join(topicPath, fileName))
        fileName = `${base}-${n}.md`
      } catch {
        break
      }
    }
    const path = join(topicPath, fileName)
    writeFileSync(
      path,
      serializeNote(
        {
          title,
          date: now.toISOString(),
          source: args.source ?? 'typed',
          status: 'structured'
        },
        args.body ?? ''
      )
    )
    return { ok: true, path }
  } catch (err) {
    return fail(String(err))
  }
}

/** Image types a pasted or dropped file may carry into a note. */
const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])

/** Folder name for a note's images, alongside the note inside its topic. */
export const ASSETS_DIR = 'assets'

export interface AssetResult {
  ok: boolean
  error?: string
  /** Path relative to the note, which is what goes in the markdown */
  src?: string
}

const noteSlug = (notePath: string): string => basename(notePath).replace(/\.md$/, '')

const visibleFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => e.name)

/** A malformed `%` escape in a note must not stop the rest of it being read. */
function decoded(text: string): string {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

/**
 * Trashes the images in one lesson's assets folder that nothing refers to any
 * more, then the folder itself once it is empty, then the topic's `assets/`.
 *
 * "Refers to" is deliberately loose, and every loosening errs toward keeping
 * a file. Every lesson in the topic counts, not just the owner, because an
 * image line cut from one lesson and pasted into another still points at the
 * first lesson's folder. The clipboard counts too: between the cut and the
 * paste the line lives nowhere else, and switching lessons in that gap is
 * exactly when a cleanup runs. And a path anywhere in the text counts, not
 * only inside `![](…)`.
 */
async function pruneAssetFolder(topic: string, slug: string): Promise<void> {
  const assets = join(topic, ASSETS_DIR)
  const dir = join(assets, slug)
  let files: string[]
  try {
    files = visibleFiles(dir)
  } catch {
    return
  }
  const texts = readdirSync(topic, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => readFileSync(join(topic, e.name), 'utf8'))
  texts.push(clipboard.readText())
  const haystack = texts.map((t) => `${t}\n${decoded(t)}`).join('\n')
  const unused = files.filter((f) => !haystack.includes(`${ASSETS_DIR}/${slug}/${f}`))
  if (unused.length === files.length) await shell.trashItem(dir)
  else for (const f of unused) await shell.trashItem(join(dir, f))
  if (visibleFiles(assets).length === 0) await shell.trashItem(assets)
}

/**
 * Clears out the images a lesson no longer shows. The editor calls this when
 * a lesson opens and when it closes, never while typing: removing an image
 * and pressing ⌘Z a second later has to bring back a picture, not a broken
 * link, and leaving the lesson discards its undo history anyway.
 */
export async function pruneNoteAssets(notePath: string): Promise<void> {
  const note = assertInsideRoot(notePath)
  if (!existsSync(note)) return
  await pruneAssetFolder(dirname(note), noteSlug(note))
}

/**
 * Saves a pasted or dropped image beside the note that received it, at
 * `<topic>/assets/<note file name>/<stamp>.<ext>`, and hands back the relative
 * path for the `![](…)` the editor inserts.
 *
 * A folder per note rather than one per topic, so deleting a note's images
 * never means working out which of a shared pile it owned. The path returned
 * is relative on purpose: the note keeps working when the notes root moves or
 * the folder is opened in another markdown editor.
 */
export function writeNoteAsset(notePath: string, ext: string, bytes: Uint8Array): AssetResult {
  const clean = ext.toLowerCase().replace(/^\./, '')
  if (!ASSET_EXTENSIONS.has(clean)) return { ok: false, error: `Unsupported image type: ${ext}` }
  try {
    const note = assertInsideRoot(notePath)
    const slug = noteSlug(note)
    const dir = join(dirname(note), ASSETS_DIR, slug)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let fileName = `${stamp}.${clean}`
    for (let n = 2; existsSync(join(dir, fileName)); n++) fileName = `${stamp}-${n}.${clean}`
    writeFileSync(join(dir, fileName), bytes)
    return { ok: true, src: `${ASSETS_DIR}/${slug}/${fileName}` }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Resolves a note-relative asset path to a file on disk, refusing anything
 * that climbs out of the notes root. The custom `chewo-asset://` protocol is
 * the renderer's only way to read these bytes, and its input is whatever a
 * markdown `![](…)` says — including `../../../etc/passwd` if a note came from
 * somewhere else — so the check is the boundary, not a formality.
 */
export function resolveNoteAsset(absolutePath: string): string {
  const resolved = assertInsideRoot(absolutePath)
  if (!statSync(resolved).isFile()) throw new Error(`not a file: ${absolutePath}`)
  return resolved
}

export function readNote(path: string): string {
  return readFileSync(assertInsideRoot(path), 'utf8')
}

/**
 * Overwrites an existing lesson and never creates one. The editor flushes its
 * last edit when it unmounts, and deleting the open lesson unmounts it after
 * the delete — so a create here would put a trashed lesson straight back.
 */
export function writeNote(path: string, content: string): void {
  const resolved = assertInsideRoot(path)
  if (!existsSync(resolved)) return
  writeFileSync(resolved, content)
}

/**
 * Rename a subject or topic folder in place; its topics and notes ride along.
 * Case-only renames ("maths" → "Maths") skip the collision check — on a
 * case-insensitive volume the target "exists" only because it is the source.
 */
export function renameNoteItem(path: string, newName: string): NotesOpResult {
  if (!isValidFolderName(newName)) return fail('Invalid name')
  try {
    const resolved = assertInsideRoot(path)
    if (resolved === resolve(getNotesRoot())) return fail('Cannot rename the notes root')
    const name = newName.trim()
    const target = join(dirname(resolved), name)
    if (target === resolved) return { ok: true, path: resolved }
    if (target.toLowerCase() !== resolved.toLowerCase() && existsSync(target))
      return fail(`"${name}" already exists`)
    renameSync(resolved, target)
    return { ok: true, path: target }
  } catch (err) {
    return fail(String(err))
  }
}

/**
 * Trash (not unlink) — works for notes and whole subject/topic folders. A
 * lesson takes its `.raw.md` transcript and its images with it; an image that
 * another lesson in the topic still shows stays behind for that lesson.
 */
export async function deleteNoteItem(path: string): Promise<NotesOpResult> {
  try {
    const resolved = assertInsideRoot(path)
    if (resolved === resolve(getNotesRoot())) return fail('Cannot delete the notes root')
    await shell.trashItem(resolved)
    if (resolved.endsWith('.md')) {
      const raw = resolved.replace(/\.md$/, '.raw.md')
      if (existsSync(raw)) await shell.trashItem(raw)
      await pruneAssetFolder(dirname(resolved), noteSlug(resolved))
    }
    return { ok: true }
  } catch (err) {
    return fail(String(err))
  }
}

export const noteDisplayName = (path: string): string => basename(path)
