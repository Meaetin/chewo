import { describe, expect, test } from 'vitest'
import { dropText, insertAt, isStageableImage, spliceWord } from '../src/renderer/src/dropPaths'

describe('isStageableImage', () => {
  test('the four types main can write', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isStageableImage(t)).toBe(true)
    }
  })

  test('an image main would refuse is not one', () => {
    expect(isStageableImage('image/heic')).toBe(false)
    expect(isStageableImage('image/svg+xml')).toBe(false)
  })

  test('not an image at all', () => {
    expect(isStageableImage('application/pdf')).toBe(false)
    // A dropped folder has no type
    expect(isStageableImage('')).toBe(false)
  })
})

describe('dropText', () => {
  test('inside the checkout, relative', () => {
    expect(dropText('/repo/src/App.tsx', '/repo')).toBe('src/App.tsx')
  })

  test('a trailing separator on the checkout changes nothing', () => {
    expect(dropText('/repo/src/App.tsx', '/repo/')).toBe('src/App.tsx')
  })

  test('outside the checkout, absolute', () => {
    expect(dropText('/Users/m/Desktop/spec.pdf', '/repo')).toBe('/Users/m/Desktop/spec.pdf')
  })

  test('a sibling directory is not inside it', () => {
    expect(dropText('/repo-other/notes.md', '/repo')).toBe('/repo-other/notes.md')
  })

  test('no checkout — Home has no repo', () => {
    expect(dropText('/Users/m/notes.md')).toBe('/Users/m/notes.md')
  })

  test('a space is backticked, or it reads as two words', () => {
    expect(dropText('/Users/m/Screen Shot.txt')).toBe('`/Users/m/Screen Shot.txt`')
    expect(dropText('/repo/my notes/a.md', '/repo')).toBe('`my notes/a.md`')
  })
})

describe('insertAt', () => {
  test('an unfocused box takes the text at the end', () => {
    expect(insertAt('fix this', 0, false)).toBe(8)
  })

  test('a focused box takes it at the caret', () => {
    expect(insertAt('fix this', 4, true)).toBe(4)
  })

  test('a caret past the end is clamped', () => {
    expect(insertAt('fix', 99, true)).toBe(3)
  })
})

describe('spliceWord', () => {
  test('into an empty box', () => {
    expect(spliceWord('', 0, 'a.md')).toEqual({ value: 'a.md ', caret: 5 })
  })

  test('a space is added when the text before it does not end in one', () => {
    expect(spliceWord('read', 4, 'a.md')).toEqual({ value: 'read a.md ', caret: 10 })
  })

  test('no double space when it does', () => {
    expect(spliceWord('read ', 5, 'a.md')).toEqual({ value: 'read a.md ', caret: 10 })
  })

  test('mid-sentence, the tail survives', () => {
    expect(spliceWord('read  then fix', 5, 'a.md')).toEqual({
      value: 'read a.md  then fix',
      caret: 10
    })
  })
})
