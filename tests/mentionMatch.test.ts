import { describe, expect, test } from 'vitest'
import { mentionAt } from '../src/renderer/src/mentionMatch'

describe('mentionAt', () => {
  test('no @ at all', () => {
    expect(mentionAt('fix the bug', 11)).toBeNull()
  })

  test('@ at the start of the message', () => {
    expect(mentionAt('@app.tsx', 8)).toEqual({ start: 0, query: 'app.tsx' })
  })

  test('@ mid-sentence, preceded by whitespace', () => {
    const value = 'look at @src/App'
    expect(mentionAt(value, value.length)).toEqual({ start: 8, query: 'src/App' })
  })

  test('caret before the @ never matches it', () => {
    const value = 'look @here at this'
    expect(mentionAt(value, 4)).toBeNull()
  })

  test('a finished mention (space after it) stops matching', () => {
    const value = 'look at @app.tsx now'
    expect(mentionAt(value, value.length)).toBeNull()
  })

  test('an email-shaped @ mid-word is not a mention', () => {
    const value = 'ping user@host.com'
    expect(mentionAt(value, value.length)).toBeNull()
  })

  test('the most recent @ wins when there are two', () => {
    const value = '@one and @two'
    expect(mentionAt(value, value.length)).toEqual({ start: 9, query: 'two' })
  })

  test('bare @ with nothing typed yet still matches, empty query', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  })
})
