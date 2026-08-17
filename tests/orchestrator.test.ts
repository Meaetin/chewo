import { describe, expect, test } from 'vitest'
import { orchestratorBrief } from '../src/shared/orchestrator'

const agents = [
  { name: 'figma-expert', description: 'Use when a Figma URL needs turning into UI code.' },
  { name: 'pr-security-reviewer', description: 'Use when a diff needs a security review.' }
]

describe('orchestratorBrief', () => {
  test('is empty when there is nobody to dispatch to', () => {
    // The caller passes no flag at all in that case: briefing a session to
    // delegate to an empty roster produces an agent that announces a plan and
    // then does everything itself, which reads as the feature being broken.
    expect(orchestratorBrief([])).toBe('')
  })

  test('names every agent with its routing description', () => {
    const brief = orchestratorBrief(agents)
    expect(brief).toContain('- figma-expert: Use when a Figma URL needs turning into UI code.')
    expect(brief).toContain('- pr-security-reviewer: Use when a diff needs a security review.')
  })

  test('asks for the owner, which is what the plan panel renders', () => {
    expect(orchestratorBrief(agents)).toMatch(/owner/)
  })

  test('says a subagent cannot see the conversation', () => {
    // The single most common way a dispatched agent fails is being under-briefed.
    expect(orchestratorBrief(agents)).toContain('cannot')
  })

  test('carries the when-not-to-delegate half', () => {
    // Without it this turns a one-line CSS fix into a three-agent fan-out.
    expect(orchestratorBrief(agents)).toContain('When not to delegate')
  })

  test('summarises the tail rather than listing a whole marketplace', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `agent-${i}`,
      description: `Does job ${i}`
    }))
    const brief = orchestratorBrief(many)
    expect(brief).toContain('agent-23')
    expect(brief).not.toContain('agent-24:')
    expect(brief).toContain('and 6 more')
  })
})
