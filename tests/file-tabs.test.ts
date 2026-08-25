import { describe, expect, test } from 'vitest'
import { openFileTab, pinOpenFile, reorderOpenFiles } from '../src/renderer/src/fileTabs'

const files = [
  { path: '/a.ts', name: 'a.ts', pinned: true },
  { path: '/b.ts', name: 'b.ts', pinned: true },
  { path: '/c.ts', name: 'c.ts', pinned: true }
]

describe('code file tab ordering', () => {
  test('moves a tab right as the pointer crosses another tab', () => {
    expect(reorderOpenFiles(files, '/a.ts', '/b.ts').map((file) => file.path)).toEqual([
      '/b.ts',
      '/a.ts',
      '/c.ts'
    ])
  })

  test('moves a tab left as the pointer crosses another tab', () => {
    expect(reorderOpenFiles(files, '/c.ts', '/a.ts').map((file) => file.path)).toEqual([
      '/c.ts',
      '/a.ts',
      '/b.ts'
    ])
  })

  test('replaces the sole preview tab', () => {
    const first = openFileTab(files, '/preview-a.ts', 'preview')
    const second = openFileTab(first, '/preview-b.ts', 'preview')
    expect(second.map((file) => file.path)).toEqual(['/a.ts', '/b.ts', '/c.ts', '/preview-b.ts'])
    expect(second.at(-1)?.pinned).toBe(false)
  })

  test('pins a preview in place', () => {
    const preview = openFileTab(files, '/preview.ts', 'preview')
    const pinned = pinOpenFile(preview, '/preview.ts')
    expect(pinned.at(-1)).toMatchObject({ path: '/preview.ts', pinned: true })
  })

  test('reordering a preview promotes it', () => {
    const preview = openFileTab(files, '/preview.ts', 'preview')
    const reordered = reorderOpenFiles(preview, '/preview.ts', '/a.ts')
    expect(reordered[0]).toMatchObject({ path: '/preview.ts', pinned: true })
  })
})
