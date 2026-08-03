import { afterAll, describe, expect, test } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ATTACHMENTS_DIR, imageBlocks, stageImage } from '../src/main/attachments'
import {
  composeMessage,
  isLongPaste,
  splitComposed,
  withImagePaths,
  type Attachment
} from '../src/shared/attachments'
import { branchNameFor } from '../src/shared/branch-names'

/**
 * Composer attachments. The load-bearing property is a round trip: whatever
 * `composeMessage` folds into a message, `splitComposed` has to fold back out,
 * because the replacement pane a first message creates renders its bubble from
 * the composed prompt — and the branch is named from it too.
 */

const text = (label: string, body: string): Attachment => ({
  id: label,
  kind: 'text',
  label,
  text: body,
  lines: body.split('\n').length
})

const image = (path: string): Attachment => ({ id: path, kind: 'image', label: 'Image 1', path })

describe('isLongPaste', () => {
  test('a sentence pastes as a sentence', () => {
    expect(isLongPaste('just a normal thing someone typed')).toBe(false)
  })

  test('a stack trace becomes an attachment', () => {
    expect(isLongPaste(Array(40).fill('  at frame').join('\n'))).toBe(true)
  })

  test('one very long line counts too — a minified blob has no newlines', () => {
    expect(isLongPaste('x'.repeat(1200))).toBe(true)
  })
})

describe('composeMessage', () => {
  test('typed text alone is untouched', () => {
    expect(composeMessage('fix the flaky test', [])).toBe('fix the flaky test')
  })

  test('pasted text is folded in verbatim, tagged so the model can see the seam', () => {
    expect(composeMessage('why does this fail?', [text('Pasted text 1', 'line a\nline b')])).toBe(
      'why does this fail?\n\n<pasted label="Pasted text 1">\nline a\nline b\n</pasted>'
    )
  })

  test('images are not mentioned — they ride as content blocks or CLI flags', () => {
    expect(composeMessage('look', [image('/tmp/a.png')])).toBe('look')
  })

  test('attachments alone still produce a message', () => {
    expect(composeMessage('', [text('Pasted text 1', 'x')])).toBe(
      '<pasted label="Pasted text 1">\nx\n</pasted>'
    )
  })
})

describe('splitComposed', () => {
  test('recovers the typed text and one chip per pasted block', () => {
    const message = composeMessage('why does this fail?', [
      text('Pasted text 1', 'line a\nline b'),
      text('Pasted text 2', 'other')
    ])
    const { display, chips } = splitComposed(message)
    expect(display).toBe('why does this fail?')
    expect(chips.map((c) => [c.label, c.lines])).toEqual([
      ['Pasted text 1', 2],
      ['Pasted text 2', 1]
    ])
  })

  test('a message with nothing folded in survives unchanged', () => {
    expect(splitComposed('plain question')).toEqual({ display: 'plain question', chips: [] })
  })

  test('a pasted block containing a blank line is not split at it', () => {
    const { chips } = splitComposed(composeMessage('x', [text('Pasted text 1', 'a\n\nb')]))
    expect(chips).toHaveLength(1)
    expect(chips[0].lines).toBe(3)
  })
})

describe('branch naming survives a paste', () => {
  test('the slug comes from the sentence, never the folded-in block', () => {
    const message = composeMessage('fix crash', [
      text('Pasted text 1', Array(40).fill('  at deploy step').join('\n'))
    ])
    expect(branchNameFor(splitComposed(message).display)).toBe('fix-crash')
  })
})

describe('withImagePaths', () => {
  test("names the files, because claude's pty reads paths out of the prompt", () => {
    expect(withImagePaths('look at this', ['/tmp/a.png', '/tmp/b.png'])).toBe(
      'look at this\n\nAttached images (read these files):\n- /tmp/a.png\n- /tmp/b.png'
    )
  })

  test('no images, no block', () => {
    expect(withImagePaths('look at this', [])).toBe('look at this')
  })
})

/**
 * The staging store. Round-tripped against the real directory rather than a
 * seam, because the guard being tested is a path comparison against it.
 */
describe('staged images', () => {
  const staged: string[] = []
  afterAll(() => {
    for (const path of staged) rmSync(path, { force: true })
  })

  test('a staged PNG comes back as a base64 content block', () => {
    const path = stageImage(Buffer.from('not really a png').toString('base64'), 'image/png')
    staged.push(path)
    expect(path.startsWith(ATTACHMENTS_DIR)).toBe(true)
    expect(imageBlocks([path])).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('not really a png').toString('base64')
        }
      }
    ])
  })

  test('a traversal out of the staging folder is refused even though the file exists', () => {
    // A real, readable file reached by walking out of the staging directory —
    // a prefix check would have accepted this one
    const outside = join(tmpdir(), `chewo-attachment-escape-${process.pid}.png`)
    writeFileSync(outside, 'secret')
    staged.push(outside)
    const traversal = `${ATTACHMENTS_DIR}/${relative(ATTACHMENTS_DIR, outside)}`
    expect(existsSync(traversal)).toBe(true)
    expect(imageBlocks([traversal])).toEqual([])
  })

  test('a subdirectory of the staging folder is not the staging folder', () => {
    expect(imageBlocks([`${ATTACHMENTS_DIR}/nested/a.png`])).toEqual([])
  })

  test('a clipboard type we cannot name a media type for is refused', () => {
    expect(() => stageImage('AAAA', 'image/tiff')).toThrow(/Unsupported/)
  })

  test('a staged file that has since been swept is dropped, not thrown', () => {
    expect(imageBlocks([`${ATTACHMENTS_DIR}/does-not-exist.png`])).toEqual([])
  })
})
