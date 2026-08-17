import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyAgent,
  copyHook,
  copyMemoryFile,
  copySkill,
  readAgentFile,
  readMemoryFile,
  writeAgent
} from '../src/main/capability-writer'
import type { AgentDraft } from '../src/shared/capabilities/agent-file'
import { parseClaudeHooks } from '../src/shared/capabilities/scan'
import type { CopyDestination, HookRef } from '../src/shared/capabilities/types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'writer-test-'))
  // source skill with a nested reference file
  mkdirSync(join(tmp, 'src-skills/gsap-core/references'), { recursive: true })
  writeFileSync(join(tmp, 'src-skills/gsap-core/SKILL.md'), '---\nname: gsap-core\n---\nbody')
  writeFileSync(join(tmp, 'src-skills/gsap-core/references/easing.md'), 'easings')
  // source agent
  mkdirSync(join(tmp, 'src-agents'), { recursive: true })
  writeFileSync(join(tmp, 'src-agents/db-architect.md'), '---\nname: db-architect\n---\n')
  // target project dirs
  mkdirSync(join(tmp, 'projA'), { recursive: true })
  mkdirSync(join(tmp, 'projB'), { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const roots = (): { claudeHome: string; codexHome: string } => ({
  claudeHome: join(tmp, 'claude-home'),
  codexHome: join(tmp, 'codex-home')
})

const dests = (): CopyDestination[] => [
  { kind: 'project', path: join(tmp, 'projA'), tool: 'claude', label: 'projA' },
  { kind: 'project', path: join(tmp, 'projA'), tool: 'codex', label: 'projA' },
  { kind: 'project', path: join(tmp, 'projB'), tool: 'claude', label: 'projB' },
  { kind: 'global', tool: 'codex', label: 'Personal' }
]

describe('copySkill', () => {
  test('copies recursively to project (both tools) and global scopes', () => {
    const results = copySkill(join(tmp, 'src-skills/gsap-core'), dests(), false, roots())
    expect(results.every((r) => r.status === 'copied')).toBe(true)
    expect(readFileSync(join(tmp, 'projA/.claude/skills/gsap-core/SKILL.md'), 'utf8')).toContain('gsap-core')
    expect(existsSync(join(tmp, 'projA/.codex/skills/gsap-core/references/easing.md'))).toBe(true)
    expect(existsSync(join(tmp, 'projB/.claude/skills/gsap-core/SKILL.md'))).toBe(true)
    expect(existsSync(join(tmp, 'codex-home/skills/gsap-core/SKILL.md'))).toBe(true)
  })

  test('collision returns exists without writing; overwrite replaces', () => {
    const target: CopyDestination[] = [
      { kind: 'project', path: join(tmp, 'projA'), tool: 'claude', label: 'projA' }
    ]
    copySkill(join(tmp, 'src-skills/gsap-core'), target, false, roots())
    // mutate the installed copy so we can detect replacement
    writeFileSync(join(tmp, 'projA/.claude/skills/gsap-core/SKILL.md'), 'OLD LOCAL EDIT')

    const second = copySkill(join(tmp, 'src-skills/gsap-core'), target, false, roots())
    expect(second[0].status).toBe('exists')
    expect(readFileSync(join(tmp, 'projA/.claude/skills/gsap-core/SKILL.md'), 'utf8')).toBe('OLD LOCAL EDIT')

    const forced = copySkill(join(tmp, 'src-skills/gsap-core'), target, true, roots())
    expect(forced[0].status).toBe('copied')
    expect(readFileSync(join(tmp, 'projA/.claude/skills/gsap-core/SKILL.md'), 'utf8')).toContain('gsap-core')
  })

  test('rejects non-skill sources and unsafe names', () => {
    mkdirSync(join(tmp, 'src-skills/not-a-skill'))
    expect(() => copySkill(join(tmp, 'src-skills/not-a-skill'), dests(), false, roots())).toThrow(/SKILL.md/)
  })

  test('per-destination errors do not abort other destinations', () => {
    const mixed: CopyDestination[] = [
      { kind: 'project', path: join(tmp, 'projA'), tool: 'claude', label: 'projA' },
      { kind: 'project', tool: 'claude', label: 'broken' } // missing path
    ]
    const results = copySkill(join(tmp, 'src-skills/gsap-core'), mixed, false, roots())
    expect(results[0].status).toBe('copied')
    expect(results[1].status).toBe('error')
  })
})

describe('copyMemoryFile', () => {
  test('duplicates to missing scopes only — never overwrites', () => {
    writeFileSync(join(tmp, 'projA/CLAUDE.md'), '# source rules')
    writeFileSync(join(tmp, 'projB/CLAUDE.md'), '# existing local rules')

    const results = copyMemoryFile(
      join(tmp, 'projA/CLAUDE.md'),
      [
        { kind: 'project', path: join(tmp, 'projB'), tool: 'claude', label: 'projB' },
        { kind: 'global', tool: 'claude', label: 'Personal' }
      ],
      roots()
    )
    // projB already has one → untouched
    expect(results[0].status).toBe('exists')
    expect(readFileSync(join(tmp, 'projB/CLAUDE.md'), 'utf8')).toBe('# existing local rules')
    // personal was missing → created in ~/.claude
    expect(results[1].status).toBe('copied')
    expect(readFileSync(join(tmp, 'claude-home/CLAUDE.md'), 'utf8')).toBe('# source rules')
  })

  test('AGENTS.md routes to codex home for the Personal scope', () => {
    writeFileSync(join(tmp, 'projA/AGENTS.md'), '- codex rule')
    const results = copyMemoryFile(
      join(tmp, 'projA/AGENTS.md'),
      [{ kind: 'global', tool: 'codex', label: 'Personal' }],
      roots()
    )
    expect(results[0].status).toBe('copied')
    expect(readFileSync(join(tmp, 'codex-home/AGENTS.md'), 'utf8')).toBe('- codex rule')
  })

  test('rejects non-instruction files, viewer read is restricted too', () => {
    writeFileSync(join(tmp, 'projA/README.md'), 'nope')
    expect(() =>
      copyMemoryFile(join(tmp, 'projA/README.md'), [{ kind: 'global', tool: 'claude', label: 'x' }], roots())
    ).toThrow(/instruction file/)
    expect(() => readMemoryFile(join(tmp, 'projA/README.md'))).toThrow(/refusing/)
    writeFileSync(join(tmp, 'projA/CLAUDE.md'), '# ok')
    expect(readMemoryFile(join(tmp, 'projA/CLAUDE.md'))).toBe('# ok')
  })
})

describe('copyHook + parseClaudeHooks', () => {
  const hookRef: HookRef = {
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'echo pre-bash-check',
    settingsPath: '/src/settings.json'
  }

  test('merges into existing settings.json preserving other keys; roundtrips through the parser', () => {
    const settingsPath = join(tmp, 'projA/.claude/settings.json')
    mkdirSync(join(tmp, 'projA/.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
      })
    )

    const results = copyHook(hookRef, [
      { kind: 'project', path: join(tmp, 'projA'), tool: 'claude', label: 'projA' }
    ])
    expect(results[0].status).toBe('copied')

    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(cfg.permissions.allow).toEqual(['Bash(ls:*)']) // untouched
    expect(cfg.hooks.Stop).toHaveLength(1) // untouched
    expect(cfg.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo pre-bash-check' }]
    })

    // the scanner reads back what the writer wrote
    const parsed = parseClaudeHooks(settingsPath)
    expect(parsed).toContainEqual(
      expect.objectContaining({ event: 'PreToolUse', matcher: 'Bash', command: 'echo pre-bash-check' })
    )
  })

  test('identical hook → exists; same matcher different command appends to the slot', () => {
    const target: CopyDestination[] = [
      { kind: 'project', path: join(tmp, 'projB'), tool: 'claude', label: 'projB' }
    ]
    expect(copyHook(hookRef, target)[0].status).toBe('copied')
    expect(copyHook(hookRef, target)[0].status).toBe('exists')

    const second = copyHook({ ...hookRef, command: 'echo other-check' }, target)
    expect(second[0].status).toBe('copied')
    const cfg = JSON.parse(readFileSync(join(tmp, 'projB/.claude/settings.json'), 'utf8'))
    expect(cfg.hooks.PreToolUse).toHaveLength(1) // one matcher slot
    expect(cfg.hooks.PreToolUse[0].hooks).toHaveLength(2) // two commands in it
  })

  test('global destination writes to ~/.claude/settings.json', () => {
    const results = copyHook(hookRef, [{ kind: 'global', tool: 'claude', label: 'Personal' }], roots())
    expect(results[0].status).toBe('copied')
    expect(existsSync(join(tmp, 'claude-home/settings.json'))).toBe(true)
  })
})

describe('copyAgent', () => {
  test('copies to project and global .claude/agents; exists on collision', () => {
    const target: CopyDestination[] = [
      { kind: 'project', path: join(tmp, 'projB'), tool: 'claude', label: 'projB' },
      { kind: 'global', tool: 'claude', label: 'Personal' }
    ]
    const results = copyAgent(join(tmp, 'src-agents/db-architect.md'), target, false, roots())
    expect(results.every((r) => r.status === 'copied')).toBe(true)
    expect(existsSync(join(tmp, 'projB/.claude/agents/db-architect.md'))).toBe(true)
    expect(existsSync(join(tmp, 'claude-home/agents/db-architect.md'))).toBe(true)

    const again = copyAgent(join(tmp, 'src-agents/db-architect.md'), target, false, roots())
    expect(again.every((r) => r.status === 'exists')).toBe(true)
  })
})

describe('writeAgent', () => {
  const dest = (): CopyDestination => ({
    kind: 'project',
    path: join(tmp, 'projA'),
    tool: 'claude',
    label: 'projA'
  })
  const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
    name: 'API Reviewer',
    description: 'Use when reviewing an API diff',
    systemPrompt: 'You review APIs.',
    tools: [],
    disallowedTools: [],
    skills: [],
    ...over
  })

  test('writes the sanitised name as the filename', () => {
    const res = writeAgent(draft(), dest(), false, roots())
    expect(res.status).toBe('copied')
    expect(res.path).toBe(join(tmp, 'projA/.claude/agents/api-reviewer.md'))
    expect(readFileSync(res.path, 'utf8')).toContain('name: api-reviewer')
  })

  test('a collision returns exists rather than writing', () => {
    writeAgent(draft(), dest(), false, roots())
    const again = writeAgent(draft({ systemPrompt: 'Different.' }), dest(), false, roots())
    expect(again.status).toBe('exists')
    expect(readFileSync(again.path, 'utf8')).toContain('You review APIs.')
  })

  test('overwriting is the edit path, and it keeps unmodelled frontmatter', () => {
    const path = join(tmp, 'projA/.claude/agents/api-reviewer.md')
    mkdirSync(join(tmp, 'projA/.claude/agents'), { recursive: true })
    writeFileSync(
      path,
      '---\nname: api-reviewer\ndescription: old\npermissionMode: acceptEdits\n---\n\nOld.\n'
    )
    const res = writeAgent(draft({ systemPrompt: 'New.' }), dest(), true, roots())
    expect(res.status).toBe('copied')
    const out = readFileSync(path, 'utf8')
    expect(out).toContain('permissionMode: acceptEdits')
    expect(out).toContain('New.')
    expect(out).not.toContain('Old.')
  })

  test('a name that cannot become a filename is an error, not a stray write', () => {
    const res = writeAgent(draft({ name: '../../etc/passwd' }), dest(), false, roots())
    // It sanitises rather than failing — the point is that it cannot escape.
    expect(res.status).toBe('copied')
    expect(res.path).toBe(join(tmp, 'projA/.claude/agents/etc-passwd.md'))
    expect(writeAgent(draft({ name: '!!!' }), dest(), false, roots())).toMatchObject({
      status: 'error'
    })
  })
})

describe('readAgentFile', () => {
  test('reads a definition out of an agents directory', () => {
    mkdirSync(join(tmp, 'claude-home/agents'), { recursive: true })
    const path = join(tmp, 'claude-home/agents/reviewer.md')
    writeFileSync(path, '---\nname: reviewer\n---\n\nBody.\n')
    expect(readAgentFile(path)).toContain('Body.')
  })

  test('refuses anything that is not a .md inside an agents dir', () => {
    // The point of a separate reader is that this channel cannot be talked
    // into reading arbitrary files — widening readMemoryFile would have.
    mkdirSync(join(tmp, 'claude-home/agents'), { recursive: true })
    writeFileSync(join(tmp, 'claude-home/agents/keys.json'), '{}')
    writeFileSync(join(tmp, 'secrets.md'), 'nope')
    expect(() => readAgentFile(join(tmp, 'claude-home/agents/keys.json'))).toThrow(/non-agent/)
    expect(() => readAgentFile(join(tmp, 'secrets.md'))).toThrow(/non-agent/)
    expect(() => readAgentFile(join(tmp, 'claude-home/agents/../../secrets.md'))).toThrow(
      /non-agent/
    )
  })
})
