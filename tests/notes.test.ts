import { describe, expect, test } from 'vitest'
import {
  isValidFolderName,
  kebabCase,
  parseNote,
  serializeNote,
  type NoteFrontmatter
} from '../src/shared/notes'

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
