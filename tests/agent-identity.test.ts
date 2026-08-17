import { describe, expect, test } from 'vitest'
import { agentHue, agentIdentity, agentInitials } from '../src/shared/agent-identity'

describe('agentInitials', () => {
  test('takes one letter per word', () => {
    expect(agentInitials('figma-expert')).toBe('FE')
    expect(agentInitials('QA Chris')).toBe('QC')
    expect(agentInitials('api_reviewer')).toBe('AR')
  })

  test('a single word gives two letters, not one', () => {
    // One letter collides constantly — a marketplace is full of f-names.
    expect(agentInitials('figma')).toBe('FI')
    expect(agentInitials('Plan')).toBe('PL')
  })

  test('reads camelCase as two words', () => {
    expect(agentInitials('figmaExpert')).toBe('FE')
  })

  test('degrades rather than throwing on a nameless agent', () => {
    expect(agentInitials('')).toBe('??')
    expect(agentInitials('---')).toBe('??')
  })
})

describe('agentHue', () => {
  test('is stable for a name', () => {
    expect(agentHue('figma-expert')).toBe(agentHue('figma-expert'))
  })

  test('separates names a character-sum hash would collide', () => {
    // The names most needing separation are the near-identical ones.
    const a = agentHue('figma-expert')
    const b = agentHue('figma-explore')
    expect(Math.abs(a - b)).toBeGreaterThan(20)
  })

  test('stays in range', () => {
    for (const n of ['a', 'reviewer', 'x'.repeat(200), 'ünïcodé']) {
      expect(agentHue(n)).toBeGreaterThanOrEqual(0)
      expect(agentHue(n)).toBeLessThan(360)
    }
  })
})

describe('agentIdentity', () => {
  test('a declared frontmatter colour wins over the hash', () => {
    expect(agentIdentity('anything', 'blue').color).toBe('hsl(217 62% 68%)')
    expect(agentIdentity('anything', ' BLUE ').color).toBe('hsl(217 62% 68%)')
  })

  test('an unrecognised colour falls back to the hash, never to grey', () => {
    // Sharing one default colour across every agent defeats the point.
    const fallback = agentIdentity('reviewer', 'chartreuse')
    expect(fallback.color).toBe(agentIdentity('reviewer').color)
  })

  test('background is the same hue, tinted', () => {
    const id = agentIdentity('reviewer')
    expect(id.background).toContain(String(agentHue('reviewer')))
    expect(id.background).toContain('0.16')
  })
})
