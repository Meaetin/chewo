import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BASE64,
  MAX_RESULT_IMAGES,
  imageDataUrl,
  splitToolResult
} from '../src/shared/tool-images'

/**
 * Shapes recorded from Claude Code 2.1.220 — a `Read` of a PNG, on both routes
 * (the live stream's `tool_result` block and the same block in the session
 * file, which carry identical values).
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const image = (data = PNG, mediaType = 'image/png'): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data }
})

describe('splitToolResult', () => {
  it('takes an image out of the content array instead of flattening it to "[image]"', () => {
    const { text, images } = splitToolResult([image()])
    expect(images).toEqual([{ mediaType: 'image/png', data: PNG }])
    expect(text).toBe('')
  })

  it('keeps prose beside the picture', () => {
    const { text, images } = splitToolResult([{ type: 'text', text: 'Read 1 image' }, image()])
    expect(text).toBe('Read 1 image')
    expect(images).toHaveLength(1)
  })

  it('passes a plain string result through, capped when asked', () => {
    expect(splitToolResult('done')).toEqual({ text: 'done', images: [] })
    expect(splitToolResult('abcdef', { textCap: 3 }).text).toBe('abc')
  })

  it('names a part it cannot render rather than dropping it', () => {
    const { text, images } = splitToolResult([{ type: 'audio' }])
    expect(images).toEqual([])
    expect(text).toBe('[audio]')
  })

  it('refuses a media type an <img> has no business painting', () => {
    const { text, images } = splitToolResult([image(PNG, 'text/html')])
    expect(images).toEqual([])
    expect(text).toBe('[image — could not be read]')
  })

  it('refuses a payload that is not base64', () => {
    const { images } = splitToolResult([image('<script>alert(1)</script>')])
    expect(images).toEqual([])
  })

  it('refuses a payload past the size guard', () => {
    const { images } = splitToolResult([image('A'.repeat(MAX_IMAGE_BASE64 + 1))])
    expect(images).toEqual([])
  })

  it('caps how many pictures one result contributes, and says so', () => {
    const parts = Array.from({ length: MAX_RESULT_IMAGES + 2 }, () => image())
    const { text, images } = splitToolResult(parts)
    expect(images).toHaveLength(MAX_RESULT_IMAGES)
    expect(text.split('\n')).toEqual(['[image — not shown]', '[image — not shown]'])
  })
})

describe('imageDataUrl', () => {
  it('builds the data URL the <img> reads', () => {
    expect(imageDataUrl({ mediaType: 'image/png', data: PNG })).toBe(
      `data:image/png;base64,${PNG}`
    )
  })
})
