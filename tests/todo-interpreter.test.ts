import { describe, expect, test } from 'vitest'
import { buildPrompt, parseInterpreterOutput } from '../src/main/todo-interpreter'

const envelope = (fields: Record<string, unknown>): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields })

describe('parseInterpreterOutput', () => {
  test('reads the commands list from structured_output', () => {
    const out = parseInterpreterOutput(
      envelope({
        structured_output: {
          commands: [
            { action: 'delete', scope: 'general', cardId: 'c1' },
            { action: 'delete', scope: 'general', cardId: 'c2' }
          ]
        }
      })
    )
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ action: 'delete', scope: 'general', cardId: 'c2' })
  })

  test('tolerates a bare single command object (schema sidestep)', () => {
    const out = parseInterpreterOutput(
      envelope({ structured_output: { action: 'move', scope: 'general', cardId: 'c1', to: 'done' } })
    )
    expect(out).toEqual([{ action: 'move', scope: 'general', cardId: 'c1', to: 'done' }])
  })

  test('falls back to a JSON string in result', () => {
    const out = parseInterpreterOutput(
      envelope({
        result: JSON.stringify({ commands: [{ action: 'add', scope: 'general', title: 'x' }] })
      })
    )
    expect(out[0].action).toBe('add')
  })

  test('non-command result text → error carrying a snippet', () => {
    expect(() => parseInterpreterOutput(envelope({ result: 'Not logged in · Please run /login' })))
      .toThrow(/Not logged in/)
  })

  test('unparseable stdout → error', () => {
    expect(() => parseInterpreterOutput('zsh: command not found: claude')).toThrow(/unparseable/)
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
