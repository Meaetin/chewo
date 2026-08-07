import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../src/renderer/src/elapsed'

describe('formatElapsed', () => {
  it('reads in seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(1_400)).toBe('1s')
    expect(formatElapsed(59_900)).toBe('59s')
  })

  it('switches to minutes, zero-padding the seconds', () => {
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(84_000)).toBe('1:24')
    expect(formatElapsed(609_000)).toBe('10:09')
  })

  it('keeps counting in minutes past an hour rather than growing a field', () => {
    expect(formatElapsed(5_000_000)).toBe('83:20')
  })

  it('never shows a negative clock', () => {
    expect(formatElapsed(-1_000)).toBe('0s')
  })
})
