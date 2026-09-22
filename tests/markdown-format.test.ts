import { describe, expect, test } from 'vitest'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import {
  insertLink,
  insertMathBlock,
  toggleHeading,
  toggleInline,
  toggleLinePrefix
} from '../src/renderer/src/markdownFormat'

/**
 * Runs a toolbar command over a document with the selection written as `|`
 * markers — one for a cursor, two for a highlighted span — and returns the
 * result in the same notation, so a test reads like the editor looks.
 *
 * A marker inserted at the very start of the selection lands outside it —
 * CodeMirror maps the selection's left edge past an insertion at that point,
 * so the words stay highlighted and the new `- ` or `## ` does not.
 */
function apply(command: StateCommand, marked: string): string {
  const first = marked.indexOf('|')
  const second = marked.indexOf('|', first + 1)
  const doc = marked.replace(/\|/g, '')
  const to = second === -1 ? first : second - 1
  const state = EditorState.create({ doc, selection: EditorSelection.single(first, to) })
  let next = state
  command({ state, dispatch: (tr) => (next = tr.state) })
  const sel = next.selection.main
  const text = next.doc.toString()
  return sel.empty
    ? text.slice(0, sel.from) + '|' + text.slice(sel.from)
    : text.slice(0, sel.from) + '|' + text.slice(sel.from, sel.to) + '|' + text.slice(sel.to)
}

describe('toggleInline', () => {
  const bold = toggleInline('**')

  test('wraps the highlighted words and keeps them highlighted', () => {
    expect(apply(bold, 'the |brachial plexus| runs')).toBe('the **|brachial plexus|** runs')
  })

  test('unwraps when the marks sit just outside the selection', () => {
    expect(apply(bold, 'the **|brachial|** runs')).toBe('the |brachial| runs')
  })

  test('unwraps when the selection swallowed the marks', () => {
    expect(apply(bold, 'the |**brachial**| runs')).toBe('the |brachial| runs')
  })

  test('with nothing selected leaves the cursor inside an empty pair', () => {
    expect(apply(bold, 'type |here')).toBe('type **|**here')
  })

  test('italic and code use the same shape', () => {
    expect(apply(toggleInline('*'), '|word|')).toBe('*|word|*')
    expect(apply(toggleInline('`'), '|word|')).toBe('`|word|`')
  })
})

describe('toggleHeading', () => {
  test('promotes the line the cursor is on', () => {
    expect(apply(toggleHeading(2), 'Brachial pl|exus')).toBe('## Brachial pl|exus')
  })

  test('replaces a heading at another level rather than stacking', () => {
    expect(apply(toggleHeading(2), '# Tit|le')).toBe('## Tit|le')
  })

  test('strips the heading when it is already at that level', () => {
    expect(apply(toggleHeading(2), '## Tit|le')).toBe('Tit|le')
  })

  test('covers every line the selection touches', () => {
    expect(apply(toggleHeading(3), '|one\ntwo|')).toBe('### |one\n### two|')
  })
})

describe('toggleLinePrefix', () => {
  const bullet = toggleLinePrefix('- ')

  test('bullets each line of the selection', () => {
    expect(apply(bullet, '|roots\ntrunks|')).toBe('- |roots\n- trunks|')
  })

  test('removes the bullets when every line already has one', () => {
    expect(apply(bullet, '|- roots\n- trunks|')).toBe('|roots\ntrunks|')
  })

  test('only adds to the lines that are missing one', () => {
    expect(apply(bullet, '|- roots\ntrunks|')).toBe('|- roots\n- trunks|')
  })

  test('leaves blank lines inside a selection alone', () => {
    expect(apply(bullet, '|roots\n\ntrunks|')).toBe('- |roots\n\n- trunks|')
  })

  test('keeps the indent of a nested line', () => {
    expect(apply(bullet, '  |roots|')).toBe('  - |roots|')
  })

  test('quotes use the same command', () => {
    expect(apply(toggleLinePrefix('> '), '|said so|')).toBe('> |said so|')
  })
})

describe('insertLink', () => {
  test('wraps the selection and selects the placeholder for pasting', () => {
    expect(apply(insertLink, 'see |the paper| for')).toBe('see [the paper](|url|) for')
  })

  test('with nothing selected the cursor waits in the label', () => {
    expect(apply(insertLink, 'see |')).toBe('see [|](url)')
  })
})

describe('insertMathBlock', () => {
  test('lifts the selection into a display equation', () => {
    expect(apply(insertMathBlock, '|E = mc^2|')).toBe('$$\nE = mc^2|\n$$\n')
  })

  test('breaks the line first when the cursor is mid-sentence', () => {
    expect(apply(insertMathBlock, 'so |')).toBe('so \n$$\n|\n$$\n')
  })
})
