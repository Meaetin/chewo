import { describe, expect, test } from 'vitest'
import { reorderOpenFiles } from '../src/renderer/src/fileTabs'

const files = [
  { path: '/a.ts', name: 'a.ts' },
  { path: '/b.ts', name: 'b.ts' },
  { path: '/c.ts', name: 'c.ts' }
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
})
