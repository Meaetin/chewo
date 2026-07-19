import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { shell } from 'electron'
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
  /** Created file path (createNote only) */
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

export function readNote(path: string): string {
  return readFileSync(assertInsideRoot(path), 'utf8')
}

export function writeNote(path: string, content: string): void {
  writeFileSync(assertInsideRoot(path), content)
}

/** Trash (not unlink) — works for notes and whole subject/topic folders. */
export async function deleteNoteItem(path: string): Promise<NotesOpResult> {
  try {
    const resolved = assertInsideRoot(path)
    if (resolved === resolve(getNotesRoot())) return fail('Cannot delete the notes root')
    await shell.trashItem(resolved)
    return { ok: true }
  } catch (err) {
    return fail(String(err))
  }
}

export const noteDisplayName = (path: string): string => basename(path)
