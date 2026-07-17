import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyAgent, copySkill } from '../src/main/capability-writer'
import type { CopyDestination } from '../src/shared/capabilities/types'

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
