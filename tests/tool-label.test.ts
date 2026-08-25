import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../src/shared/agent-chat'
import { toolInputText, toolLabel } from '../src/shared/tool-label'

const call = (over: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1',
  name: 'Bash',
  input: {},
  status: 'ok',
  ...over
})

describe('toolLabel', () => {
  it('names a command by the description the model wrote for it', () => {
    const label = toolLabel(
      call({ name: 'Bash', input: { command: 'ls src/main/ && ls src/preload/', description: 'List main and preload' } })
    )
    expect(label).toEqual({ title: 'List main and preload', detail: 'ls src/main/ && ls src/preload/' })
  })

  it('falls back to a plain verb when a command carries no description', () => {
    expect(toolLabel(call({ name: 'Bash', input: { command: 'npm test' } }))).toEqual({
      title: 'Ran a command',
      detail: 'npm test'
    })
  })

  it('names a file tool by what it did to the file', () => {
    expect(toolLabel(call({ name: 'Edit', input: { file_path: '/a/b.ts' } }))).toEqual({
      title: 'Edited',
      detail: '/a/b.ts'
    })
    expect(toolLabel(call({ name: 'Write', input: { file_path: '/a/b.ts', content: 'x' } })).title).toBe('Wrote')
    expect(toolLabel(call({ name: 'Grep', input: { pattern: 'foo' } }))).toEqual({
      title: 'Searched',
      detail: 'foo'
    })
  })

  it('names a dispatch after the task, never after the prompt', () => {
    const label = toolLabel(
      call({
        name: 'Agent',
        input: {
          subagent_type: 'backend-architect',
          description: 'Wire the route handlers',
          prompt: 'You are implementing **Step 15**…'.repeat(50)
        }
      })
    )
    expect(label).toEqual({ title: 'Wire the route handlers', detail: '' })
  })

  it('reads an MCP tool as its own name and server', () => {
    expect(toolLabel(call({ name: 'mcp__chewo__todo_add', input: {} }))).toEqual({
      title: 'todo add',
      detail: 'chewo'
    })
  })

  it('falls back to the CLI description, then to the tool name', () => {
    expect(toolLabel(call({ name: 'Whatever', description: 'Did a thing', input: {} })).title).toBe('Did a thing')
    expect(toolLabel(call({ name: 'Whatever', displayName: 'What Ever', input: {} })).title).toBe('What Ever')
    expect(toolLabel(call({ name: 'Whatever', input: { url: 'https://x' } })).detail).toBe('https://x')
  })
})

describe('toolInputText', () => {
  it('shows a command as a command', () => {
    expect(toolInputText(call({ name: 'Bash', input: { command: 'npm test', description: 'd' } }))).toBe('$ npm test')
  })

  it('shows a subagent its whole brief, unescaped', () => {
    const prompt = 'Line one\nLine two'
    expect(toolInputText(call({ name: 'Agent', input: { prompt, subagent_type: 'x' } }))).toBe(prompt)
  })

  it('shows anything else as its arguments', () => {
    expect(toolInputText(call({ name: 'Read', input: { file_path: '/a/b.ts' } }))).toBe(
      '{\n  "file_path": "/a/b.ts"\n}'
    )
  })

  it('has nothing to show before the arguments have streamed in', () => {
    expect(toolInputText(call({ name: 'Read', input: {} }))).toBeNull()
    expect(toolInputText(call({ name: 'Read', input: undefined }))).toBeNull()
  })
})
