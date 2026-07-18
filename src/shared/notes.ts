/**
 * Notes workflow data model (SPEC-NOTES.md §5). Notes are plain markdown
 * files with YAML-ish frontmatter, organized Subject/Topic/note.md under a
 * single notes root. Disk is the only data source — this module is the pure
 * parse/serialize layer shared by main and renderer.
 */

export type NoteSource = 'dictation' | 'paste' | 'typed'
export type NoteStatus = 'raw' | 'structured'

export interface NoteMeta {
  /** Absolute path to the .md file */
  path: string
  fileName: string
  title: string
  /** ISO timestamp — frontmatter `date`, else file mtime */
  date: string
  source: NoteSource
  status: NoteStatus
}

/** Sub-level (OneNote "section"): e.g. "Lesson 1", "Algebra" */
export interface NotesTopic {
  name: string
  path: string
  notes: NoteMeta[]
}

/** Top-level (OneNote "notebook"): e.g. "Cooking class", "Maths" */
export interface NotesSubject {
  name: string
  path: string
  topics: NotesTopic[]
}

export interface NotesTree {
  root: string
  subjects: NotesSubject[]
}

export interface NoteFrontmatter {
  title: string
  date: string
  source: NoteSource
  status: NoteStatus
}

export interface ParsedNote extends Partial<NoteFrontmatter> {
  body: string
}

/** Spec default (SPEC-NOTES.md §2): base.en misheard accents; turbo fixes it. */
export const DEFAULT_STT_MODEL = 'openai_whisper-large-v3-v20240930_turbo'

/** One JSON line from the STT sidecar (SPEC-NOTES.md §6.1). */
export interface SttEvent {
  event: 'loading' | 'ready' | 'level' | 'partial' | 'final' | 'error'
  rms?: number
  confirmed?: string
  tail?: string
  text?: string
  duration_s?: number
  message?: string
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

/** Tolerant frontmatter parse — files without frontmatter are all body. */
export function parseNote(content: string): ParsedNote {
  const match = FRONTMATTER.exec(content)
  if (!match) return { body: content }
  const parsed: ParsedNote = { body: content.slice(match[0].length).replace(/^\n/, '') }
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (key === 'title') parsed.title = value
    else if (key === 'date') parsed.date = value
    else if (key === 'source' && (value === 'dictation' || value === 'paste' || value === 'typed'))
      parsed.source = value
    else if (key === 'status' && (value === 'raw' || value === 'structured'))
      parsed.status = value
  }
  return parsed
}

export function serializeNote(meta: NoteFrontmatter, body: string): string {
  return `---\ntitle: ${meta.title}\ndate: ${meta.date}\nsource: ${meta.source}\nstatus: ${meta.status}\n---\n\n${body}`
}

/** "Brachial Plexus!" → "brachial-plexus" (filename slug) */
export function kebabCase(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  )
}

/** One path segment: non-empty, no separators, not hidden. */
export function isValidFolderName(name: string): boolean {
  const trimmed = name.trim()
  return (
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !trimmed.startsWith('.') &&
    !/[/\\:]/.test(trimmed)
  )
}
