import { describe, expect, it } from 'vitest'
import { parseToolPatch, patchStats, patchToUnified } from '../src/shared/diff'
import { parseDiff } from '../src/renderer/src/components/DiffBody'

/**
 * Shapes here are recorded from Claude Code 2.1.220 (`tool_use_result` on the
 * live stream, `toolUseResult` in the session file — identical values).
 */

const EDIT_RESULT = {
  filePath: '/repo/sample.txt',
  oldString: 'line three',
  newString: 'line THREE',
  originalFile: 'line one\nline two\nline three\n',
  structuredPatch: [
    {
      oldStart: 34,
      oldLines: 4,
      newStart: 34,
      newLines: 5,
      lines: [' line one', '-line three', '+line THREE', '+line THREE-and-a-half', ' line two']
    }
  ],
  userModified: false,
  replaceAll: false
}

describe('parseToolPatch', () => {
  it('reads an Edit patch, line numbers and all', () => {
    const patch = parseToolPatch(EDIT_RESULT)
    expect(patch?.filePath).toBe('/repo/sample.txt')
    expect(patch?.hunks[0].oldStart).toBe(34)
    expect(patch?.hunks[0].lines).toHaveLength(5)
    expect(patchStats(patch!)).toEqual({ added: 2, removed: 1 })
  })

  it('turns a created file into an all-added hunk — Write reports an empty patch', () => {
    const patch = parseToolPatch({
      type: 'create',
      filePath: '/repo/new.txt',
      content: 'alpha\nbeta\n',
      structuredPatch: [],
      originalFile: null
    })
    expect(patch?.created).toBe(true)
    expect(patch?.hunks[0]).toMatchObject({ oldStart: 0, newStart: 1, lines: ['+alpha', '+beta'] })
  })

  it('ignores a tool that touched no file', () => {
    // Read's result — a file payload, but nothing was changed
    expect(parseToolPatch({ type: 'text', file: { filePath: '/repo/a.txt' } })).toBeUndefined()
    expect(parseToolPatch('Command exited with 0')).toBeUndefined()
    expect(parseToolPatch(undefined)).toBeUndefined()
    expect(parseToolPatch({ filePath: '/repo/a.txt', structuredPatch: 'nonsense' })).toBeUndefined()
  })

  it('caps a huge write and says how much it dropped', () => {
    const content = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    const patch = parseToolPatch({ type: 'create', filePath: '/repo/big.txt', content })
    expect(patch?.hunks[0].lines).toHaveLength(500)
    expect(patch?.omitted).toBe(100)
  })
})

describe('patchToUnified', () => {
  it('round-trips through the renderer with the CLI’s line numbers intact', () => {
    const patch = parseToolPatch(EDIT_RESULT)!
    const { text, hidden } = patchToUnified(patch)
    expect(hidden).toBe(0)

    const { lines } = parseDiff(text)
    // Header, then a row per diff line — numbered from the hunk's own start
    expect(lines.map((l) => [l.type, l.no, l.text])).toEqual([
      ['hunk', null, '@@ -34,4 +34,5 @@'],
      ['ctx', 34, 'line one'],
      ['del', 35, 'line three'],
      ['add', 35, 'line THREE'],
      ['add', 36, 'line THREE-and-a-half'],
      ['ctx', 37, 'line two']
    ])
  })

  it('folds to a row budget and reports what is left', () => {
    const patch = parseToolPatch(EDIT_RESULT)!
    const { text, hidden } = patchToUnified(patch, 2)
    expect(hidden).toBe(3)
    expect(text.split('\n')).toHaveLength(3) // header + 2 rows
  })

  it('counts rows the parser already dropped as hidden too', () => {
    const content = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    const patch = parseToolPatch({ type: 'create', filePath: '/repo/big.txt', content })!
    expect(patchToUnified(patch, 10).hidden).toBe(590)
  })
})
