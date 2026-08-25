import { describe, expect, test } from 'vitest'
import { joinDictated } from '../src/renderer/src/dictation'

/**
 * Dictated words land on top of whatever was already typed, because pressing
 * the mic in the middle of writing must not throw the sentence away.
 */
describe('joinDictated', () => {
  test('an empty box takes the transcript as-is', () => {
    expect(joinDictated('', 'ship the branch')).toBe('ship the branch')
  })

  test('typed words keep their place, with one space between', () => {
    expect(joinDictated('fix', 'the base picker')).toBe('fix the base picker')
  })

  test('a space already there is not doubled', () => {
    expect(joinDictated('fix ', 'the base picker')).toBe('fix the base picker')
  })

  test('a newline is structure — a list keeps its shape', () => {
    expect(joinDictated('- one\n', 'two')).toBe('- one\ntwo')
  })

  test('hearing nothing leaves the message exactly as it was', () => {
    expect(joinDictated('half a sentence', '')).toBe('half a sentence')
  })
})
