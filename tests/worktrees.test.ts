import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  branchFor,
  createWorktree,
  listBranches,
  validateBaseRef,
  validateTaskName,
  worktreeDirFor,
  WORKTREES_ROOT
} from '../src/main/worktrees'
import { buildCommand } from '../src/main/terminals'

describe('validateTaskName', () => {
  test('accepts plain task slugs', () => {
    expect(validateTaskName('auth-fix')).toBeNull()
    expect(validateTaskName('v2.1_migration')).toBeNull()
    expect(validateTaskName('123abc')).toBeNull()
  })

  test('rejects names git or the filesystem would choke on', () => {
    expect(validateTaskName('')).not.toBeNull()
    expect(validateTaskName('  ')).not.toBeNull()
    expect(validateTaskName('has space')).not.toBeNull()
    expect(validateTaskName('-leading-dash')).not.toBeNull()
    expect(validateTaskName('.hidden')).not.toBeNull()
    expect(validateTaskName('a/b')).not.toBeNull()
    expect(validateTaskName('a..b')).not.toBeNull()
    expect(validateTaskName('x.lock')).not.toBeNull()
    expect(validateTaskName('x'.repeat(61))).not.toBeNull()
  })
})

describe('worktree naming', () => {
  test('branch and directory derive from the task name', () => {
    expect(branchFor('auth-fix')).toBe('agent/auth-fix')
    expect(worktreeDirFor('/Users/m/dev/argo', 'auth-fix')).toBe(
      `${WORKTREES_ROOT}/argo/auth-fix`
    )
    // worktrees live OUTSIDE the repo so main-checkout watchers never see them
    expect(WORKTREES_ROOT.startsWith(homedir())).toBe(true)
    expect(worktreeDirFor('/Users/m/dev/argo', 'x').startsWith('/Users/m/dev/argo')).toBe(false)
  })
})

// Real git: a base branch that isn't the checked-out one is exactly the case
// the branch picker exists for, and only git can prove the start point took.
describe('base branch selection', () => {
  let repo: string
  let mainTip: string
  let featureTip: string

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=t@t',
        ...args
      ],
      { encoding: 'utf8' }
    )

  const headOf = (dir: string): string =>
    execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wt-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
    mainTip = headOf(repo)

    git('checkout', '-b', 'feature')
    writeFileSync(join(repo, 'b.txt'), 'two\n')
    git('add', '-A')
    git('commit', '-m', 'feature work')
    featureTip = headOf(repo)
    git('checkout', 'main')
  })

  afterAll(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('lists local branches with the checked-out one as current', async () => {
    const res = await listBranches(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.current).toBe('main')
    expect(res.local.sort()).toEqual(['feature', 'main'])
    expect(res.remote).toEqual([])
  })

  test('non-repo path is reported, not thrown', async () => {
    const res = await listBranches(homedir())
    expect(res.ok).toBe(false)
  })

  test('the new branch starts at the chosen base, not at HEAD', async () => {
    const res = await createWorktree(repo, 'on-feature', 'feature')
    if (!res.ok) throw new Error(res.error)
    expect(res.baseBranch).toBe('feature')
    expect(res.branch).toBe('agent/on-feature')
    expect(headOf(res.path)).toBe(featureTip)
  })

  test('no base keeps the old behaviour — the main checkout HEAD', async () => {
    const res = await createWorktree(repo, 'on-head')
    if (!res.ok) throw new Error(res.error)
    expect(res.baseBranch).toBe('main')
    expect(headOf(res.path)).toBe(mainTip)
  })

  test('a base that does not resolve fails before the checkout', async () => {
    const res = await createWorktree(repo, 'ghost', 'no-such-branch')
    expect(res).toEqual({ ok: false, error: 'Base branch not found: no-such-branch' })
  })

  test('flag-shaped bases never reach git argv', async () => {
    expect(validateBaseRef('--upload-pack=touch /tmp/pwn')).not.toBeNull()
    expect(validateBaseRef('')).not.toBeNull()
    expect(validateBaseRef('origin/main')).toBeNull()
    const res = await createWorktree(repo, 'flagbase', '--force')
    expect(res.ok).toBe(false)
  })
})

describe('buildCommand with setup', () => {
  test('setup command chains before the agent and gates its launch', () => {
    expect(
      buildCommand({ source: 'claude', setupCommand: 'cp ../.env . && npm install' })
    ).toBe('(cp ../.env . && npm install) && claude')
    expect(buildCommand({ source: 'codex', setupCommand: 'npm i' })).toBe('(npm i) && codex')
  })

  test('no setup → plain agent command; shells never get one', () => {
    expect(buildCommand({ source: 'claude' })).toBe('claude')
    expect(buildCommand({ source: 'claude', sessionId: 'abc' })).toBe('claude --resume abc')
    expect(buildCommand({ source: 'shell', setupCommand: 'npm i' })).toBeNull()
  })
})

describe('buildCommand permission flags', () => {
  test('claude gets --permission-mode, fresh and on resume', () => {
    expect(buildCommand({ source: 'claude', permissionMode: 'auto' })).toBe(
      'claude --permission-mode auto'
    )
    expect(buildCommand({ source: 'claude', sessionId: 'abc', permissionMode: 'plan' })).toBe(
      'claude --resume abc --permission-mode plan'
    )
  })

  test('codex gets --ask-for-approval, fresh and on resume', () => {
    expect(buildCommand({ source: 'codex', approvalPolicy: 'never' })).toBe(
      'codex --ask-for-approval never'
    )
    expect(buildCommand({ source: 'codex', sessionId: 'xyz', approvalPolicy: 'on-request' })).toBe(
      'codex resume xyz --ask-for-approval on-request'
    )
  })

  test('unset mode leaves the CLI at its own default', () => {
    expect(buildCommand({ source: 'claude', permissionMode: undefined })).toBe('claude')
    expect(buildCommand({ source: 'codex', approvalPolicy: undefined })).toBe('codex')
  })

  test("each CLI ignores the other's setting", () => {
    expect(buildCommand({ source: 'claude', approvalPolicy: 'never' })).toBe('claude')
    expect(buildCommand({ source: 'codex', permissionMode: 'auto' })).toBe('codex')
  })

  test('values outside the known enums never reach the shell', () => {
    // projects.json is user-editable — a hand-edited mode must not inject
    expect(buildCommand({ source: 'claude', permissionMode: 'auto; rm -rf /' })).toBe('claude')
    expect(buildCommand({ source: 'claude', permissionMode: 'bogus' })).toBe('claude')
    expect(buildCommand({ source: 'codex', approvalPolicy: '$(whoami)' })).toBe('codex')
  })

  test('setup command and permission flag compose', () => {
    expect(
      buildCommand({ source: 'claude', setupCommand: 'npm i', permissionMode: 'acceptEdits' })
    ).toBe('(npm i) && claude --permission-mode acceptEdits')
  })
})
