import { describe, expect, test } from 'vitest'
import { toolPolicy } from '../src/renderer/src/components/capabilities/CapabilityRows'
import type { AgentRef } from '../src/shared/capabilities/types'

const agent = (over: Partial<AgentRef> = {}): AgentRef => ({
  name: 'reviewer',
  description: 'Reviews code',
  path: '/a/reviewer.md',
  origin: { kind: 'user' },
  tools: [],
  disallowedTools: [],
  skills: [],
  ...over
})

describe('toolPolicy', () => {
  test('an empty allowlist reads as "all tools", never as a restriction', () => {
    // The inverted reading is the trap: omitting `tools` grants everything,
    // so rendering "none" here would describe a permissive agent as locked down.
    expect(toolPolicy(agent())).toBe('all tools')
  })

  test('an allowlist is listed as-is', () => {
    expect(toolPolicy(agent({ tools: ['Read', 'Grep'] }))).toBe('Read, Grep')
  })

  test('a denylist qualifies whichever grant precedes it', () => {
    expect(toolPolicy(agent({ disallowedTools: ['Write'] }))).toBe('all tools · except Write')
    expect(toolPolicy(agent({ tools: ['Read'], disallowedTools: ['Write', 'Edit'] }))).toBe(
      'Read · except Write, Edit'
    )
  })
})
