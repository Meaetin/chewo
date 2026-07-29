import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  isValidFolderName,
  kebabCase,
  parseNote,
  serializeNote,
  type NoteFrontmatter
} from '../src/shared/notes'

// notes.ts pulls in electron only for shell.trashItem (delete, not rename)
vi.mock('electron', () => ({ shell: { trashItem: async () => {} } }))
const { renameNoteItem, scanNotes, setNotesRoot } = await import('../src/main/notes')

const META: NoteFrontmatter = {
  title: 'Brachial plexus',
  date: '2026-07-17T14:05:00.000Z',
  source: 'dictation',
  status: 'structured'
}

describe('parseNote / serializeNote', () => {
  test('roundtrip preserves frontmatter and body exactly', () => {
    const body = '## Roots\n\nC5–T1 form the plexus.\n'
    const parsed = parseNote(serializeNote(META, body))
    expect(parsed.title).toBe(META.title)
    expect(parsed.date).toBe(META.date)
    expect(parsed.source).toBe('dictation')
    expect(parsed.status).toBe('structured')
    expect(parsed.body).toBe(body)
  })

  test('repeated roundtrips do not accumulate blank lines', () => {
    let content = serializeNote(META, 'text')
    for (let i = 0; i < 3; i++) {
      const p = parseNote(content)
      content = serializeNote({ ...META, title: p.title! }, p.body)
    }
    expect(parseNote(content).body).toBe('text')
  })

  test('file without frontmatter is all body', () => {
    const parsed = parseNote('# Just markdown\n\nno frontmatter here')
    expect(parsed.title).toBeUndefined()
    expect(parsed.body).toBe('# Just markdown\n\nno frontmatter here')
  })

  test('unknown and malformed frontmatter values are ignored, not fatal', () => {
    const parsed = parseNote('---\ntitle: Ok\nsource: teleport\nbogus\nstatus: raw\n---\nbody')
    expect(parsed.title).toBe('Ok')
    expect(parsed.source).toBeUndefined()
    expect(parsed.status).toBe('raw')
    expect(parsed.body).toBe('body')
  })

  test('titles containing colons keep everything after the first colon', () => {
    const parsed = parseNote('---\ntitle: Lesson 1: Knife skills\n---\n')
    expect(parsed.title).toBe('Lesson 1: Knife skills')
  })
})

describe('kebabCase', () => {
  test('slugs punctuation and casing', () => {
    expect(kebabCase('Brachial Plexus!')).toBe('brachial-plexus')
    expect(kebabCase('  Lesson 1: Knife skills  ')).toBe('lesson-1-knife-skills')
  })

  test('never returns an empty slug', () => {
    expect(kebabCase('!!!')).toBe('untitled')
    expect(kebabCase('')).toBe('untitled')
  })
})

describe('renameNoteItem', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chewo-notes-'))
    setNotesRoot(root)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const seed = (subject: string, topic = 'Lesson 1'): string => {
    const topicPath = join(root, subject, topic)
    mkdirSync(topicPath, { recursive: true })
    writeFileSync(join(topicPath, '2026-07-29-note.md'), serializeNote(META, 'body'))
    return topicPath
  }

  test('renames a subject folder and its notes ride along', () => {
    seed('Maths')
    const res = renameNoteItem(join(root, 'Maths'), 'Mathematics')
    expect(res.ok).toBe(true)
    expect(res.path).toBe(join(root, 'Mathematics'))
    const subject = scanNotes().subjects.find((s) => s.name === 'Mathematics')
    expect(subject?.topics[0].notes).toHaveLength(1)
  })

  test('renames a topic folder', () => {
    seed('Cooking', 'Lesson 1')
    expect(renameNoteItem(join(root, 'Cooking', 'Lesson 1'), 'Knife skills').ok).toBe(true)
    const subject = scanNotes().subjects.find((s) => s.name === 'Cooking')
    expect(subject?.topics.map((t) => t.name)).toEqual(['Knife skills'])
  })

  test('case-only rename is allowed on a case-insensitive volume', () => {
    seed('biology')
    const res = renameNoteItem(join(root, 'biology'), 'Biology')
    expect(res.ok).toBe(true)
    expect(scanNotes().subjects.some((s) => s.name === 'Biology')).toBe(true)
  })

  test('refuses a name already taken by a sibling', () => {
    seed('Physics')
    seed('Chemistry')
    const res = renameNoteItem(join(root, 'Physics'), 'Chemistry')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('already exists')
  })

  test('refuses invalid names, paths outside the root, and the root itself', () => {
    seed('History')
    expect(renameNoteItem(join(root, 'History'), 'a/b').ok).toBe(false)
    expect(renameNoteItem(join(root, 'History'), '  ').ok).toBe(false)
    expect(renameNoteItem(join(root, '..', 'elsewhere'), 'Nope').ok).toBe(false)
    expect(renameNoteItem(root, 'NewRoot').ok).toBe(false)
  })
})

describe('isValidFolderName', () => {
  test('accepts ordinary subject/topic names', () => {
    expect(isValidFolderName('Cooking class')).toBe(true)
    expect(isValidFolderName('Lesson 1')).toBe(true)
  })

  test('rejects empty, hidden, and path-escaping names', () => {
    expect(isValidFolderName('')).toBe(false)
    expect(isValidFolderName('   ')).toBe(false)
    expect(isValidFolderName('.hidden')).toBe(false)
    expect(isValidFolderName('a/b')).toBe(false)
    expect(isValidFolderName('a\\b')).toBe(false)
  })
})
