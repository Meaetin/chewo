import { describe, expect, test } from 'vitest'
import {
  agentFileName,
  draftFromFile,
  sanitizeAgentName,
  serializeAgent,
  type AgentDraft
} from '../src/shared/capabilities/agent-file'
import { readDraft, type SkillOption } from '../src/shared/capabilities/agent-draft'

const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  tools: [],
  disallowedTools: [],
  skills: [],
  ...over
})

describe('sanitizeAgentName', () => {
  test('an apostrophe is an elision, not a word boundary', () => {
    // Same rule as slugifyBranch: `picker's` must not become `picker-s`, which
    // spends a word on a stray letter.
    expect(sanitizeAgentName("Martin's Reviewer")).toBe('martins-reviewer')
  })

  test('collapses runs and trims separators', () => {
    expect(sanitizeAgentName('  Code   Review!! ')).toBe('code-review')
  })

  test('cannot escape the agents directory', () => {
    // A model writes this value, and it becomes a path.
    expect(sanitizeAgentName('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeAgentName('.hidden')).toBe('hidden')
  })

  test('a name with nothing sluggable refuses to become a filename', () => {
    expect(sanitizeAgentName('!!!')).toBe('')
    expect(() => agentFileName('!!!')).toThrow(/no usable characters/)
    expect(agentFileName('API Reviewer')).toBe('api-reviewer.md')
  })
})

describe('serializeAgent', () => {
  test('writes the body as the whole system prompt', () => {
    const out = serializeAgent(draft({ systemPrompt: 'Line one.\n\nLine two.' }))
    expect(out).toBe(
      ['---', 'name: reviewer', 'description: Reviews code', '---', '', 'Line one.', '', 'Line two.', ''].join('\n')
    )
  })

  test('omits an empty tool allowlist rather than writing `tools: []`', () => {
    // The two are opposites: omitted grants every tool, `[]` grants none.
    expect(serializeAgent(draft())).not.toContain('tools:')
    expect(serializeAgent(draft({ tools: ['Read', 'Grep'] }))).toContain('tools: [Read, Grep]')
  })

  test('quotes any value whose punctuation would change its meaning', () => {
    const out = serializeAgent(
      draft({ description: 'Use PROACTIVELY: reviews diffs, hunts bugs # fast' })
    )
    expect(out).toContain('description: "Use PROACTIVELY: reviews diffs, hunts bugs # fast"')
  })

  test('escapes quotes and backslashes rather than emitting broken YAML', () => {
    const out = serializeAgent(draft({ description: 'Say "hi" via C:\\path' }))
    expect(out).toContain('description: "Say \\"hi\\" via C:\\\\path"')
  })

  test('folds a multi-line description onto one line', () => {
    // A stray newline in a plain scalar silently ends the value.
    expect(serializeAgent(draft({ description: 'first\n  second' }))).toContain(
      'description: first second'
    )
  })

  test('only preloaded skills reach the frontmatter', () => {
    const out = serializeAgent(
      draft({
        skills: [
          { name: 'pdf', reason: 'reads specs', preload: true, installed: true },
          { name: 'xlsx', reason: 'rarely', preload: false, installed: true }
        ]
      })
    )
    expect(out).toContain('skills: [pdf]')
    expect(out).not.toContain('xlsx')
  })

  test('the reason for a skill is never written to disk', () => {
    const out = serializeAgent(
      draft({ skills: [{ name: 'pdf', reason: 'needs to read specs', preload: true, installed: true }] })
    )
    expect(out).not.toContain('needs to read specs')
  })

  test('sanitises the name on the way out, so the file and the handle agree', () => {
    expect(serializeAgent(draft({ name: 'API Reviewer' }))).toContain('name: api-reviewer')
  })
})

describe('serializeAgent round-trip', () => {
  const existing = [
    '---',
    'name: reviewer',
    'description: Reviews code',
    'permissionMode: acceptEdits',
    'maxTurns: 12',
    'model: sonnet',
    'hooks:',
    '  PreToolUse:',
    '    - command: ./guard.sh',
    '---',
    '',
    'Old prompt.',
    ''
  ].join('\n')

  test('preserves frontmatter keys this app does not model', () => {
    // The failure mode without this is silent: the agent still loads, it just
    // quietly lost its permission mode and its hooks.
    const out = serializeAgent(draft({ name: 'reviewer', model: 'opus' }), existing)
    expect(out).toContain('permissionMode: acceptEdits')
    expect(out).toContain('maxTurns: 12')
    expect(out).toContain('hooks:')
    expect(out).toContain('  PreToolUse:')
    expect(out).toContain('    - command: ./guard.sh')
  })

  test('keeps unknown keys in their original position', () => {
    const out = serializeAgent(draft({ name: 'reviewer', model: 'opus' }), existing)
    const keys = out
      .split('\n---')[0]
      .split('\n')
      .filter((l) => /^[A-Za-z_]/.test(l))
      .map((l) => l.split(':')[0])
    expect(keys).toEqual(['name', 'description', 'permissionMode', 'maxTurns', 'model', 'hooks'])
  })

  test('a modelled key cleared in the draft leaves the file', () => {
    const out = serializeAgent(draft({ name: 'reviewer', model: undefined }), existing)
    expect(out).not.toContain('model:')
    expect(out).toContain('permissionMode: acceptEdits')
  })

  test('replaces the body wholesale — it is the system prompt', () => {
    const out = serializeAgent(draft({ systemPrompt: 'New prompt.' }), existing)
    expect(out).toContain('New prompt.')
    expect(out).not.toContain('Old prompt.')
  })

  test('parse → serialize is stable across a second pass', () => {
    const once = serializeAgent(draft(), existing)
    const twice = serializeAgent(draft(), once)
    expect(twice).toBe(once)
  })
})

describe('draftFromFile', () => {
  test('reads an inline list, a block sequence and a folded scalar alike', () => {
    const md = [
      '---',
      'name: designer',
      'description: >-',
      '  Use when the task touches',
      '  visual design.',
      'tools: [Read, Grep]',
      'skills:',
      '  - figma-use',
      '  - figma-code-connect',
      '---',
      '',
      'You are a designer.',
      ''
    ].join('\n')
    const d = draftFromFile(md)
    expect(d.name).toBe('designer')
    expect(d.description).toBe('Use when the task touches visual design.')
    expect(d.tools).toEqual(['Read', 'Grep'])
    expect(d.skills.map((s) => s.name)).toEqual(['figma-use', 'figma-code-connect'])
    expect(d.systemPrompt).toBe('You are a designer.')
  })

  test('anything already in `skills:` is preloaded by definition', () => {
    const md = '---\nname: a\ndescription: b\nskills: [pdf]\n---\n\nBody.\n'
    expect(draftFromFile(md).skills).toEqual([
      { name: 'pdf', reason: '', preload: true, installed: true }
    ])
  })

  test('an absent model reads as inherit, not as an empty string', () => {
    const md = '---\nname: a\ndescription: b\n---\n\nBody.\n'
    const d = draftFromFile(md)
    expect(d.model).toBeUndefined()
    expect(d.tools).toEqual([])
  })

  test('a file with no frontmatter is all body rather than a parse error', () => {
    const d = draftFromFile('Just a prompt.\n')
    expect(d.name).toBe('')
    expect(d.systemPrompt).toBe('Just a prompt.')
  })
})

describe('readDraft', () => {
  const offered: SkillOption[] = [
    { name: 'pdf', description: 'Reads PDFs', origin: 'document-skills plugin', installed: true },
    {
      name: 'figma-use',
      description: 'Drives Figma',
      origin: 'figma plugin (disabled)',
      installed: false,
      pluginId: 'figma@marketplace'
    }
  ]
  const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'API Reviewer',
    description: 'Use when reviewing an API diff',
    systemPrompt: 'You review APIs.',
    ...over
  })

  test('sanitises the name the model chose', () => {
    expect(readDraft(raw(), offered).name).toBe('api-reviewer')
  })

  test('refuses a draft missing a name, a router or a prompt', () => {
    expect(() => readDraft(raw({ name: '###' }), offered)).toThrow(/no usable name/)
    expect(() => readDraft(raw({ description: '' }), offered)).toThrow(/incomplete/)
    expect(() => readDraft(raw({ systemPrompt: '  ' }), offered)).toThrow(/incomplete/)
  })

  test('drops a skill the model invented', () => {
    // An unknown name in `skills:` is a preload that fails at spawn, and the
    // user cannot tell a hallucinated skill from one they haven't installed.
    const d = readDraft(
      raw({ skills: [{ name: 'pdf', reason: 'specs' }, { name: 'imaginary', reason: 'nope' }] }),
      offered
    )
    expect(d.skills.map((s) => s.name)).toEqual(['pdf'])
  })

  test('preload is the user’s call, never the drafting model’s', () => {
    const d = readDraft(raw({ skills: [{ name: 'pdf', reason: 'specs', preload: true }] }), offered)
    expect(d.skills[0].preload).toBe(false)
  })

  test('carries install state and plugin id through from the inventory', () => {
    const d = readDraft(raw({ skills: [{ name: 'figma-use', reason: 'design work' }] }), offered)
    expect(d.skills[0]).toEqual({
      name: 'figma-use',
      reason: 'design work',
      preload: false,
      installed: false,
      pluginId: 'figma@marketplace'
    })
  })

  test('deduplicates a repeated skill', () => {
    const d = readDraft(
      raw({ skills: [{ name: 'pdf', reason: 'a' }, { name: 'pdf', reason: 'b' }] }),
      offered
    )
    expect(d.skills).toHaveLength(1)
  })

  test('survives junk in every optional field', () => {
    const d = readDraft(
      raw({ model: null, effort: 42, tools: 'Read', disallowedTools: [1, 'Write'], skills: 'none' }),
      offered
    )
    expect(d.model).toBeUndefined()
    expect(d.effort).toBeUndefined()
    expect(d.tools).toEqual([])
    expect(d.disallowedTools).toEqual(['Write'])
    expect(d.skills).toEqual([])
  })

  test('a draft round-trips into a file that keeps only what belongs there', () => {
    const d = readDraft(
      raw({ model: 'opus', skills: [{ name: 'pdf', reason: 'reads the spec' }] }),
      offered
    )
    const file = serializeAgent(d)
    expect(file).toContain('name: api-reviewer')
    expect(file).toContain('model: opus')
    // Chosen but not preloaded, so it stays discoverable rather than costing
    // its full body on every invocation.
    expect(file).not.toContain('skills:')
    expect(file).not.toContain('reads the spec')
  })
})
