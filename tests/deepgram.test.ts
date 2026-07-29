import { describe, expect, test } from 'vitest'
import {
  MAX_SENTENCES_PER_PARAGRAPH,
  PARAGRAPH_GAP_S,
  TranscriptAssembler,
  type ResultsMessage
} from '../src/main/deepgram'

/**
 * The Deepgram mapping layer, over the message shapes the streaming API
 * actually sends. Pure — no network, no key — which is the whole reason
 * `TranscriptAssembler` is separate from the socket.
 */

/** One `Results` message, shaped as Deepgram sends it. */
function results(
  transcript: string,
  { start = 0, duration = 1, final = false }: { start?: number; duration?: number; final?: boolean } = {}
): ResultsMessage {
  return {
    type: 'Results',
    start,
    duration,
    is_final: final,
    channel: { alternatives: [{ transcript }] }
  }
}

describe('interim results', () => {
  test('an interim becomes the tail and leaves confirmed empty', () => {
    const a = new TranscriptAssembler()
    expect(a.accept(results('the mitochondria'))).toBe(true)
    expect(a.snapshot()).toEqual({ confirmed: '', tail: 'the mitochondria' })
  })

  test('each interim replaces the previous one rather than appending', () => {
    const a = new TranscriptAssembler()
    a.accept(results('the mito'))
    a.accept(results('the mitochondria is'))
    expect(a.snapshot().tail).toBe('the mitochondria is')
  })

  test('an unchanged interim reports no update, so the UI stays still', () => {
    const a = new TranscriptAssembler()
    a.accept(results('same words'))
    expect(a.accept(results('same words'))).toBe(false)
  })

  test('a non-Results message is ignored', () => {
    const a = new TranscriptAssembler()
    expect(a.accept({ ...results('x'), type: 'UtteranceEnd' })).toBe(false)
    expect(a.snapshot()).toEqual({ confirmed: '', tail: '' })
  })
})

describe('is_final accumulation', () => {
  test('a final moves text into confirmed and clears the tail', () => {
    const a = new TranscriptAssembler()
    a.accept(results('the mitochondria'))
    a.accept(results('The mitochondria is the powerhouse.', { final: true, duration: 2 }))
    expect(a.snapshot()).toEqual({
      confirmed: 'The mitochondria is the powerhouse.',
      tail: ''
    })
  })

  test('consecutive finals join with a single space', () => {
    const a = new TranscriptAssembler()
    a.accept(results('First part.', { start: 0, duration: 1, final: true }))
    a.accept(results('Second part.', { start: 1.2, duration: 1, final: true }))
    expect(a.snapshot().confirmed).toBe('First part. Second part.')
  })

  test('empty finals during silence add nothing', () => {
    const a = new TranscriptAssembler()
    a.accept(results('Words.', { start: 0, duration: 1, final: true }))
    a.accept(results('', { start: 1, duration: 3, final: true }))
    expect(a.snapshot().confirmed).toBe('Words.')
  })

  test('an empty final clears a stale tail', () => {
    const a = new TranscriptAssembler()
    a.accept(results('half a thought'))
    expect(a.accept(results('', { final: true }))).toBe(true)
    expect(a.snapshot().tail).toBe('')
  })
})

describe('paragraph breaks', () => {
  test(`a gap longer than ${PARAGRAPH_GAP_S}s starts a new paragraph`, () => {
    const a = new TranscriptAssembler()
    a.accept(results('Before the pause.', { start: 0, duration: 2, final: true }))
    a.accept(results('After the pause.', { start: 2 + PARAGRAPH_GAP_S + 0.5, duration: 2, final: true }))
    expect(a.snapshot().confirmed).toBe('Before the pause.\n\nAfter the pause.')
  })

  test('a gap at exactly the threshold does not break', () => {
    const a = new TranscriptAssembler()
    a.accept(results('One.', { start: 0, duration: 2, final: true }))
    a.accept(results('Two.', { start: 2 + PARAGRAPH_GAP_S, duration: 1, final: true }))
    expect(a.snapshot().confirmed).toBe('One. Two.')
  })

  test('silence between two finals still counts as a gap', () => {
    // The empty final in the middle must not advance the clock, or a pause
    // Deepgram happens to report during would never break a paragraph.
    const a = new TranscriptAssembler()
    a.accept(results('Before.', { start: 0, duration: 1, final: true }))
    a.accept(results('', { start: 1, duration: 3, final: true }))
    a.accept(results('After.', { start: 4, duration: 1, final: true }))
    expect(a.snapshot().confirmed).toBe('Before.\n\nAfter.')
  })

  test(`an unbroken speaker breaks after ${MAX_SENTENCES_PER_PARAGRAPH} sentences`, () => {
    const a = new TranscriptAssembler()
    for (let i = 0; i < 6; i++) {
      a.accept(results(`Sentence ${i}.`, { start: i, duration: 0.9, final: true }))
    }
    const paragraphs = a.snapshot().confirmed.split('\n\n')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toBe('Sentence 0. Sentence 1. Sentence 2. Sentence 3.')
    expect(paragraphs[1]).toBe('Sentence 4. Sentence 5.')
  })

  test('the sentence budget only breaks at a sentence boundary', () => {
    // The budget is spent from the first message, but confirmed ends
    // mid-sentence — so the break has to wait rather than cut a clause in two.
    const a = new TranscriptAssembler()
    a.accept(results('A. B. C. D and more', { start: 0, duration: 1, final: true }))
    a.accept(results('still going', { start: 1.1, duration: 1, final: true }))
    a.accept(results('wrapping up.', { start: 2.2, duration: 1, final: true }))
    expect(a.snapshot().confirmed).toBe('A. B. C. D and more still going wrapping up.')

    // Now it ends a sentence, so the next final is where the break lands.
    a.accept(results('New thought.', { start: 3.3, duration: 1, final: true }))
    expect(a.snapshot().confirmed).toBe(
      'A. B. C. D and more still going wrapping up.\n\nNew thought.'
    )
  })

  test('paragraphs never appear in the tail', () => {
    const a = new TranscriptAssembler()
    a.accept(results('One. Two. Three. Four.', { start: 0, duration: 4, final: true }))
    a.accept(results('an interim after a long pause', { start: 99 }))
    expect(a.snapshot().tail).toBe('an interim after a long pause')
  })
})

describe('final assembly', () => {
  test('text() joins confirmed and a leftover tail', () => {
    const a = new TranscriptAssembler()
    a.accept(results('Complete sentence.', { start: 0, duration: 1, final: true }))
    a.accept(results('cut off mid', { start: 1.1 }))
    expect(a.text()).toBe('Complete sentence. cut off mid')
  })

  test('a recording with nothing in it yields an empty string', () => {
    expect(new TranscriptAssembler().text()).toBe('')
  })

  test('paragraph breaks survive into the final text', () => {
    const a = new TranscriptAssembler()
    a.accept(results('Part one.', { start: 0, duration: 1, final: true }))
    a.accept(results('Part two.', { start: 10, duration: 1, final: true }))
    expect(a.text()).toBe('Part one.\n\nPart two.')
  })

  test('a full dictation: interims, finals, a pause, a trailing interim', () => {
    const a = new TranscriptAssembler()
    a.accept(results('so the key'))
    a.accept(results('so the key idea'))
    a.accept(results('So the key idea is entropy.', { start: 0, duration: 3, final: true }))
    a.accept(results('', { start: 3, duration: 2.5, final: true }))
    a.accept(results('which always increases', { start: 5.5, duration: 2 }))
    a.accept(results('Which always increases.', { start: 5.5, duration: 2, final: true }))
    a.accept(results('and that', { start: 7.6 }))

    expect(a.snapshot().confirmed).toBe('So the key idea is entropy.\n\nWhich always increases.')
    expect(a.text()).toBe('So the key idea is entropy.\n\nWhich always increases. and that')
  })
})
