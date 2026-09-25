import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  isValidFolderName,
  noteAssetUrl,
  kebabCase,
  parseNote,
  serializeNote,
  type NoteFrontmatter
} from '../src/shared/notes'

// notes.ts pulls in electron for the Trash and the clipboard. Trashing here
// removes for real, so a test can see what went.
const clip = vi.hoisted(() => ({ text: '' }))
vi.mock('electron', async () => {
  const { rmSync } = await import('node:fs')
  return {
    shell: { trashItem: async (p: string) => rmSync(p, { recursive: true }) },
    clipboard: { readText: () => clip.text }
  }
})
const {
  deleteNoteItem,
  pruneNoteAssets,
  renameNoteItem,
  resolveNoteAsset,
  scanNotes,
  setNotesRoot,
  writeNote,
  writeNoteAsset
} = await import('../src/main/notes')

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

describe('writeNoteAsset', () => {
  let root: string
  let note: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chewo-assets-'))
    setNotesRoot(root)
    const topic = join(root, 'Anatomy', 'Upper Limb')
    mkdirSync(topic, { recursive: true })
    note = join(topic, '2026-07-29-brachial-plexus.md')
    writeFileSync(note, serializeNote(META, 'body'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

  test('files the image under the note it was pasted into', () => {
    const res = writeNoteAsset(note, 'png', png)
    expect(res.ok).toBe(true)
    expect(res.src).toMatch(/^assets\/2026-07-29-brachial-plexus\/[\d-]+T[\d-]+Z?\.png$/)
    expect(existsSync(join(root, 'Anatomy', 'Upper Limb', res.src!))).toBe(true)
    expect([...readFileSync(join(root, 'Anatomy', 'Upper Limb', res.src!))]).toEqual([...png])
  })

  test('two images pasted in the same millisecond both survive', () => {
    const a = writeNoteAsset(note, 'png', png)
    const b = writeNoteAsset(note, 'png', png)
    expect(a.src).not.toBe(b.src)
    expect(existsSync(join(root, 'Anatomy', 'Upper Limb', b.src!))).toBe(true)
  })

  test('refuses a file type the preview cannot show', () => {
    const res = writeNoteAsset(note, 'pdf', png)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unsupported')
  })

  test('refuses a note outside the notes root', () => {
    const res = writeNoteAsset(join(tmpdir(), 'elsewhere.md'), 'png', png)
    expect(res.ok).toBe(false)
  })

  test('the assets folder is not mistaken for a topic or a note', () => {
    writeNoteAsset(note, 'png', png)
    const subject = scanNotes().subjects.find((s) => s.name === 'Anatomy')
    expect(subject?.topics.map((t) => t.name)).toEqual(['Upper Limb'])
    expect(subject?.topics[0].notes.map((n) => n.fileName)).toEqual([
      '2026-07-29-brachial-plexus.md'
    ])
  })
})

describe('image cleanup', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  let root: string
  let topic: string

  /** A fresh topic per test, with one lesson that shows the images given. */
  function lesson(name: string, body = ''): string {
    const path = join(topic, name)
    writeFileSync(path, serializeNote(META, body))
    return path
  }
  const image = (note: string): string => writeNoteAsset(note, 'png', png).src!
  const onDisk = (src: string): boolean => existsSync(join(topic, src))

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chewo-prune-'))
    setNotesRoot(root)
  })
  beforeEach(() => {
    topic = mkdtempSync(join(root, 'topic-'))
    clip.text = ''
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('keeps an image the lesson shows and trashes one it no longer does', async () => {
    const note = lesson('a.md')
    const kept = image(note)
    const dropped = image(note)
    writeNote(note, serializeNote(META, `![](${kept})`))
    await pruneNoteAssets(note)
    expect(onDisk(kept)).toBe(true)
    expect(onDisk(dropped)).toBe(false)
  })

  test('trashes the emptied folder and the emptied assets folder', async () => {
    const note = lesson('a.md')
    image(note)
    await pruneNoteAssets(note)
    expect(existsSync(join(topic, 'assets'))).toBe(false)
  })

  test('reads a space the editor wrote as %20', async () => {
    const note = lesson('my lesson.md')
    const src = image(note)
    writeNote(note, serializeNote(META, `![](${src.replace(/ /g, '%20')})`))
    await pruneNoteAssets(note)
    expect(onDisk(src)).toBe(true)
  })

  test('keeps an image another lesson in the topic now shows', async () => {
    const a = lesson('a.md')
    const src = image(a)
    lesson('b.md', `![](${src})`)
    await pruneNoteAssets(a)
    expect(onDisk(src)).toBe(true)
  })

  test('keeps an image whose line is on the clipboard, cut but not yet pasted', async () => {
    const note = lesson('a.md')
    const src = image(note)
    clip.text = `![](${src})`
    await pruneNoteAssets(note)
    expect(onDisk(src)).toBe(true)
  })

  test('does nothing for a lesson that is gone', async () => {
    const note = lesson('a.md')
    const src = image(note)
    rmSync(note)
    await pruneNoteAssets(note)
    expect(onDisk(src)).toBe(true)
  })

  test('deleting a lesson takes its transcript and images with it', async () => {
    const note = lesson('a.md')
    const src = image(note)
    writeNote(note, serializeNote(META, `![](${src})`))
    writeFileSync(join(topic, 'a.raw.md'), 'transcript')
    lesson('b.md')
    expect((await deleteNoteItem(note)).ok).toBe(true)
    expect(readdirSync(topic)).toEqual(['b.md'])
  })

  test('deleting a lesson leaves an image another lesson shows', async () => {
    const a = lesson('a.md')
    const shared = image(a)
    const own = image(a)
    writeNote(a, serializeNote(META, `![](${shared}) ![](${own})`))
    lesson('b.md', `![](${shared})`)
    await deleteNoteItem(a)
    expect(onDisk(shared)).toBe(true)
    expect(onDisk(own)).toBe(false)
  })

  test('a save to a deleted lesson does not bring it back', async () => {
    const note = lesson('a.md')
    await deleteNoteItem(note)
    writeNote(note, 'late autosave')
    expect(existsSync(note)).toBe(false)
  })
})

describe('resolveNoteAsset', () => {
  let root: string
  let asset: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chewo-resolve-'))
    setNotesRoot(root)
    const dir = join(root, 'Anatomy', 'Upper Limb', 'assets', 'note')
    mkdirSync(dir, { recursive: true })
    asset = join(dir, 'shot.png')
    writeFileSync(asset, 'bytes')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('serves a file inside the notes root', () => {
    expect(resolveNoteAsset(asset)).toBe(asset)
  })

  test('refuses a path that climbs out of the root', () => {
    expect(() => resolveNoteAsset(join(root, '..', '..', 'etc', 'passwd'))).toThrow(
      /outside notes root/
    )
  })

  test('refuses a directory', () => {
    expect(() => resolveNoteAsset(join(root, 'Anatomy'))).toThrow(/not a file/)
  })
})

describe('noteAssetUrl', () => {
  const note = '/Users/me/Notes/Anatomy/Upper Limb/lesson.md'

  test('resolves a relative image against the note it lives in', () => {
    expect(noteAssetUrl(note, 'assets/lesson/shot.png')).toBe(
      'chewo-asset://asset/' +
        encodeURIComponent('/Users/me/Notes/Anatomy/Upper Limb/assets/lesson/shot.png')
    )
  })

  test('undoes the escaping the markdown link needed', () => {
    expect(noteAssetUrl(note, 'assets/my%20lesson/shot.png')).toContain(
      encodeURIComponent('assets/my lesson/shot.png')
    )
  })

  test('leaves a real URL alone', () => {
    expect(noteAssetUrl(note, 'https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(noteAssetUrl(note, 'data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  })

  test('leaves an absolute path alone', () => {
    expect(noteAssetUrl(note, '/tmp/a.png')).toBe('/tmp/a.png')
  })
})
