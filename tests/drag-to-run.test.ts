import { describe, expect, test } from 'vitest'
import { buildCommand } from '../src/main/terminals'
import { shellQuote } from '../src/shared/shell'
import { composeCardPrompt, type TodoCard } from '../src/shared/todos'

/**
 * Drag-to-run (SPEC-TODOS §10). Card text reaches a `zsh -il -c` command
 * line, so the quoting here is a security boundary, not a formatting detail:
 * a card titled `$(…)` must arrive as characters, never as a command.
 */

/** Undo one layer of zsh single-quoting, failing loudly on anything else. */
function parseSingleQuoted(quoted: string): string {
  let out = ''
  let i = 0
  while (i < quoted.length) {
    if (quoted[i] !== "'") throw new Error(`unquoted character at ${i}: ${quoted.slice(i)}`)
    const end = quoted.indexOf("'", i + 1)
    if (end === -1) throw new Error('unterminated quote')
    out += quoted.slice(i + 1, end)
    i = end + 1
    // Between quoted runs zsh only ever sees our own \' escape
    if (quoted.startsWith("\\'", i)) {
      out += "'"
      i += 2
    }
  }
  return out
}

const argOf = (command: string, prefix: string): string =>
  parseSingleQuoted(command.slice(prefix.length))

describe('shellQuote', () => {
  test('round-trips the payloads that would otherwise execute', () => {
    const payloads = [
      "it's",
      '$(id)',
      '`id`',
      '${HOME}',
      'a; touch /tmp/x',
      'a && b || c',
      'a\nb\n\nc',
      '"double" and \'single\'',
      'back\\slash',
      '*.ts ~ ?',
      ''
    ]
    for (const payload of payloads) {
      expect(parseSingleQuoted(shellQuote(payload))).toBe(payload)
    }
  })
})

describe('buildCommand with a prompt', () => {
  test('the prompt rides as a quoted positional arg', () => {
    expect(buildCommand({ source: 'claude', initialPrompt: 'Todo: ship it' })).toBe(
      `claude 'Todo: ship it'`
    )
  })

  test('shell metacharacters in card content stay literal', () => {
    // The string from the §13 T5 checklist — nothing here may execute
    const nasty = "test '$(touch /tmp/pwned)' `id` ; echo $HOME"
    const command = buildCommand({ source: 'claude', initialPrompt: nasty })!
    expect(argOf(command, 'claude ')).toBe(nasty)
    // and the payload really is one argument — no unquoted gaps
    expect(command.startsWith(`claude '`)).toBe(true)
  })

  test('newlines survive — the prompt is multi-paragraph', () => {
    const prompt = 'Todo: fix the thing\n\nsome detail\nmore detail'
    const command = buildCommand({ source: 'claude', initialPrompt: prompt })!
    expect(argOf(command, 'claude ')).toBe(prompt)
  })

  test('extraDirs are quoted --add-dir flags AFTER the prompt', () => {
    // --add-dir is variadic: with the prompt after it, claude parses the
    // prompt as a second directory and starts with no prompt at all
    // (reproduced against CLI 2.1.x, 2026-07-20)
    expect(
      buildCommand({
        source: 'claude',
        initialPrompt: 'hi',
        extraDirs: ["/Users/x/My Stuff/o'brien/assets"]
      })
    ).toBe(`claude 'hi' --add-dir '/Users/x/My Stuff/o'\\''brien/assets'`)
  })

  test('composes with resume, permission mode, and setup command', () => {
    expect(
      buildCommand({
        source: 'claude',
        sessionId: 'abc',
        permissionMode: 'plan',
        setupCommand: 'npm i',
        initialPrompt: 'go',
        extraDirs: ['/tmp/a']
      })
    ).toBe(`(npm i) && claude --resume abc --permission-mode plan 'go' --add-dir '/tmp/a'`)
  })

  test('claude takes --model and --effort, before the prompt', () => {
    expect(
      buildCommand({ source: 'claude', model: 'opus', effort: 'high', initialPrompt: 'go' })
    ).toBe(`claude --model 'opus' --effort 'high' 'go'`)
  })

  test('codex spells effort as a config override, not a flag', () => {
    expect(buildCommand({ source: 'codex', model: 'gpt-5.6-sol', effort: 'high' })).toBe(
      `codex -m 'gpt-5.6-sol' -c 'model_reasoning_effort="high"'`
    )
  })

  test('a model id is quoted, so it cannot become anything but one argument', () => {
    // Model ids come from a CLI's own catalog, but they reach a command line —
    // there is no enum to validate against the way permission modes have one
    const command = buildCommand({ source: 'codex', model: "a'; touch /tmp/pwned; '" })!
    expect(argOf(command, 'codex -m ')).toBe("a'; touch /tmp/pwned; '")
  })

  test('no model or effort adds nothing', () => {
    expect(buildCommand({ source: 'claude', model: '', effort: '  ' })).toBe('claude')
  })

  test('a whitespace-only prompt adds nothing', () => {
    expect(buildCommand({ source: 'claude', initialPrompt: '   \n ' })).toBe('claude')
  })

  test('codex takes the same positional prompt', () => {
    expect(buildCommand({ source: 'codex', initialPrompt: 'go', approvalPolicy: 'never' })).toBe(
      `codex --ask-for-approval never 'go'`
    )
  })

  test('codex attaches images with -i instead of unlocking a directory', () => {
    // Codex has no --add-dir for reads and its file tools can't read a PNG,
    // so the files ride as attachments; -i is variadic, hence prompt first
    expect(
      buildCommand({
        source: 'codex',
        initialPrompt: 'go',
        extraDirs: ['/a/assets'],
        attachImages: ["/a/assets/o'brien.png", '/a/assets/b.png']
      })
    ).toBe(`codex 'go' -i '/a/assets/o'\\''brien.png' -i '/a/assets/b.png'`)
  })

  test('claude ignores attachImages — it reads the paths in the prompt', () => {
    expect(
      buildCommand({
        source: 'claude',
        initialPrompt: 'go',
        extraDirs: ['/a/assets'],
        attachImages: ['/a/assets/a.png']
      })
    ).toBe(`claude 'go' --add-dir '/a/assets'`)
  })

  test('a shell pane ignores the prompt entirely', () => {
    expect(buildCommand({ source: 'shell', initialPrompt: 'go' })).toBeNull()
  })
})

describe('composeCardPrompt', () => {
  const card = (over: Partial<TodoCard>): TodoCard => ({
    id: 'c1',
    title: 'Fix the flaky test',
    createdAt: '',
    updatedAt: '',
    ...over
  })

  test('title only', () => {
    expect(composeCardPrompt(card({}), '/a/assets')).toBe('Todo: Fix the flaky test')
  })

  test('text follows verbatim, one blank line down', () => {
    expect(composeCardPrompt(card({ text: 'fails ~1 in 5\non CI only' }), '/a/assets')).toBe(
      'Todo: Fix the flaky test\n\nfails ~1 in 5\non CI only'
    )
  })

  test('images become absolute paths under the scope assets dir', () => {
    expect(composeCardPrompt(card({ images: ['a.png', 'b.png'] }), '/a/assets')).toBe(
      'Todo: Fix the flaky test\n\nReference images (read these files):\n- /a/assets/a.png\n- /a/assets/b.png'
    )
  })

  test('no preamble is added — the prompt reads as typed', () => {
    const prompt = composeCardPrompt(card({ text: 'x' }), '/a/assets')
    expect(prompt.startsWith('Todo: ')).toBe(true)
    expect(prompt).not.toMatch(/assistant|user asked|please/i)
  })
})
