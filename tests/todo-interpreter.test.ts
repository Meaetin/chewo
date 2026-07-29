import { describe, expect, test } from 'vitest'
import { buildPrompt, COMMAND_SCHEMA, parseInterpreterOutput } from '../src/main/todo-interpreter'
import { toStrictSchema } from '../src/main/agent-runner'

describe('parseInterpreterOutput', () => {
  test('reads the commands list', () => {
    const out = parseInterpreterOutput({
      commands: [
        { action: 'delete', scope: 'general', cardId: 'c1' },
        { action: 'delete', scope: 'general', cardId: 'c2' }
      ]
    })
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ action: 'delete', scope: 'general', cardId: 'c2' })
  })

  test('tolerates a bare single command object (schema sidestep)', () => {
    const out = parseInterpreterOutput({
      action: 'move',
      scope: 'general',
      cardId: 'c1',
      to: 'done'
    })
    expect(out).toEqual([{ action: 'move', scope: 'general', cardId: 'c1', to: 'done' }])
  })

  test('an object with neither commands nor action → error carrying a snippet', () => {
    expect(() => parseInterpreterOutput({ note: 'Not logged in · Please run /login' })).toThrow(
      /Not logged in/
    )
  })

  test('a non-object (agent returned prose) → error', () => {
    expect(() => parseInterpreterOutput('zsh: command not found: claude')).toThrow(/unparseable/)
    expect(() => parseInterpreterOutput(null)).toThrow(/unparseable/)
  })
})

describe('toStrictSchema', () => {
  // codex exec --output-schema validates against OpenAI strict mode, which
  // demands every property be listed in `required` and additionalProperties
  // be false — our schema is written for claude's looser --json-schema.
  const strict = toStrictSchema(JSON.parse(COMMAND_SCHEMA)) as {
    required: string[]
    additionalProperties: boolean
    properties: { commands: { items: { required: string[]; additionalProperties: boolean } } }
  }

  test('root lists every property as required and forbids extras', () => {
    expect(strict.required).toEqual(['commands'])
    expect(strict.additionalProperties).toBe(false)
  })

  test('widens nested array items past the hand-written required list', () => {
    const items = strict.properties.commands.items
    expect(items.required).toEqual(['action', 'scope', 'cardId', 'title', 'text', 'to'])
    expect(items.additionalProperties).toBe(false)
  })

  test('leaves the source schema untouched', () => {
    const source = JSON.parse(COMMAND_SCHEMA) as {
      properties: { commands: { items: { required: string[] } } }
    }
    expect(source.properties.commands.items.required).toEqual(['action', 'scope'])
  })

  test('passes through scalars and arrays of scalars', () => {
    expect(toStrictSchema({ type: 'string', enum: ['a', 'b'] })).toEqual({
      type: 'string',
      enum: ['a', 'b']
    })
  })
})

describe('buildPrompt', () => {
  test('embeds transcript, scopes, the wake-word rule, and multi-command rule', () => {
    const prompt = buildPrompt('che-wo, add a todo for printing', [
      { scope: 'general', name: 'General', cards: [] }
    ])
    expect(prompt).toContain('"che-wo, add a todo for printing"')
    expect(prompt).toContain('"scope":"general"')
    expect(prompt).toContain('wake word')
    expect(prompt).toContain('two delete commands')
  })
})
