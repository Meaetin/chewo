import { describe, expect, test } from 'vitest'
import { launchedAgent, launchedTask } from '../src/shared/subagent'

describe('launchedAgent', () => {
  test('reads the subagent off a launch', () => {
    expect(launchedAgent('Agent', { subagent_type: 'figma-expert' })).toBe('figma-expert')
    expect(launchedAgent('Task', { subagent_type: 'figma-expert' })).toBe('figma-expert')
  })

  test('never matches the plan tools, which only share a prefix', () => {
    // TaskCreate/TaskUpdate/TaskList/TaskGet/TaskOutput/TaskStop launch nothing.
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop'])
      expect(launchedAgent(name, { subagent_type: 'x' })).toBeNull()
  })

  test('is null when the input has not streamed in yet', () => {
    // The chip appears before the arguments finish streaming.
    expect(launchedAgent('Agent', undefined)).toBeNull()
    expect(launchedAgent('Agent', {})).toBeNull()
    expect(launchedAgent('Agent', { subagent_type: '  ' })).toBeNull()
  })

  test('is null for an ordinary tool', () => {
    expect(launchedAgent('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('launchedTask', () => {
  test('prefers the short description over the full brief', () => {
    expect(launchedTask({ description: 'Build the hero', prompt: 'x'.repeat(4000) })).toBe(
      'Build the hero'
    )
    expect(launchedTask({ prompt: 'long' })).toBeNull()
  })
})
