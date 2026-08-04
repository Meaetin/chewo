import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  branchFor,
  createWorktree,
  listBranches,
  listWorktrees,
  removeWorktree,
  validateBaseRef,
  worktreeState,
  validateTaskName,
  worktreeDirFor,
  WORKTREES_ROOT
} from '../src/main/worktrees'
import { buildCommand } from '../src/main/terminals'

/** Land a branch in the main checkout — the app no longer does this, but the
 *  "this branch is spent" detection still has to recognise it when git does. */
const landInMain = (repo: string, branch: string): void => {
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'merge', '--no-ff', '--no-edit', branch])
}

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

// A branch cut from `origin/<default>` inherits that remote branch as its
// upstream unless we say otherwise, which makes Ship's `git push` refuse with
// "the upstream branch of your current branch does not match the name of your
// current branch" — the failure mode this pins.
describe('task branches do not inherit the base branch upstream', () => {
  let repo: string
  let remote: string

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-wt-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    repo = mkdtempSync(join(homedir(), '.chewo-wt-upstream-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
    git('remote', 'add', 'origin', remote)
    git('push', '-u', 'origin', 'main')
  })

  afterAll(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  test('a worktree based on origin/main gets no upstream at all', async () => {
    const res = await createWorktree(repo, 'from-origin', 'origin/main')
    if (!res.ok) throw new Error(res.error)
    // `git config --get` exits 1 on a missing key, which is the passing case
    let merge = ''
    try {
      merge = execFileSync('git', ['-C', repo, 'config', '--get', `branch.${res.branch}.merge`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      merge = ''
    }
    expect(merge).toBe('')
  })
})

// The sidebar's branch list comes from git, not from our records — this is
// what makes a worktree survive a closed pane or a wiped projects.json.
describe('listWorktrees', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wtlist-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
  })

  afterAll(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('reports every isolated checkout, with the main checkout excluded', async () => {
    await createWorktree(repo, 'alpha')
    await createWorktree(repo, 'beta')

    const res = await listWorktrees(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.head).toBe('main')
    expect(res.worktrees.map((w) => w.taskName).sort()).toEqual(['alpha', 'beta'])
    expect(res.worktrees.map((w) => w.branch).sort()).toEqual([
      'agent/alpha',
      'agent/beta'
    ])
    expect(res.worktrees.every((w) => w.path.startsWith(WORKTREES_ROOT))).toBe(true)
  })

  test('a worktree the user made elsewhere is not ours to list', async () => {
    const outside = mkdtempSync(join(homedir(), '.chewo-wt-outside-'))
    rmSync(outside, { recursive: true, force: true })
    git('worktree', 'add', '-b', 'mine', outside)
    try {
      const res = await listWorktrees(repo)
      if (!res.ok) throw new Error(res.error)
      expect(res.worktrees.some((w) => w.path === outside)).toBe(false)
    } finally {
      git('worktree', 'remove', '--force', outside)
    }
  })

  test('a removed checkout disappears from the list', async () => {
    const made = await createWorktree(repo, 'gone')
    if (!made.ok) throw new Error(made.error)
    await removeWorktree(repo, made.path, made.branch)
    const res = await listWorktrees(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.worktrees.some((w) => w.taskName === 'gone')).toBe(false)
  })

  test('non-repo path is reported, not thrown', async () => {
    const res = await listWorktrees(homedir())
    expect(res.ok).toBe(false)
  })
})

// Removal is unforced by default so the automatic paths (the merged-PR reaper,
// cleanup after a ship) can never lose work git would have saved. `discard` is
// the deliberate abandon, and the whole point of it is that git stops refusing.
describe('removeWorktree', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  const branchExists = (branch: string): boolean => {
    try {
      git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
      return true
    } catch {
      return false
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wtrm-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
  })

  afterEach(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('refuses a checkout with uncommitted work, and keeps it on disk', async () => {
    const made = await createWorktree(repo, 'dirty')
    if (!made.ok) throw new Error(made.error)
    writeFileSync(join(made.path, 'scratch.txt'), 'in progress\n')

    const res = await removeWorktree(repo, made.path, made.branch)
    expect(res.ok).toBe(false)
    expect(existsSync(made.path)).toBe(true)
    expect(branchExists(made.branch)).toBe(true)
  })

  test('discard throws the uncommitted work away, checkout and branch with it', async () => {
    const made = await createWorktree(repo, 'abandon')
    if (!made.ok) throw new Error(made.error)
    writeFileSync(join(made.path, 'scratch.txt'), 'in progress\n')

    const res = await removeWorktree(repo, made.path, made.branch, true)
    expect(res).toEqual({ ok: true, branchDeleted: true })
    expect(existsSync(made.path)).toBe(false)
    expect(branchExists(made.branch)).toBe(false)
  })

  test('a clean checkout on an unmerged branch loses the checkout but keeps the branch', async () => {
    const made = await createWorktree(repo, 'unmerged')
    if (!made.ok) throw new Error(made.error)
    writeFileSync(join(made.path, 'b.txt'), 'work\n')
    execFileSync('git', ['-C', made.path, 'add', '-A'])
    execFileSync('git', [
      '-C', made.path, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'work'
    ])

    const res = await removeWorktree(repo, made.path, made.branch)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.branchDeleted).toBe(false)
    expect(res.note).toBeTruthy()
    expect(existsSync(made.path)).toBe(false)
    expect(branchExists(made.branch)).toBe(true)
  })

  test('discard deletes an unmerged branch outright', async () => {
    const made = await createWorktree(repo, 'unmerged-force')
    if (!made.ok) throw new Error(made.error)
    writeFileSync(join(made.path, 'b.txt'), 'work\n')
    execFileSync('git', ['-C', made.path, 'add', '-A'])
    execFileSync('git', [
      '-C', made.path, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'work'
    ])

    const res = await removeWorktree(repo, made.path, made.branch, true)
    expect(res).toEqual({ ok: true, branchDeleted: true })
    expect(branchExists(made.branch)).toBe(false)
  })
})

// Locking a branch the sidebar thinks is spent is destructive if it's wrong —
// a fresh worktree and a merged one both sit at "nothing ahead of main".
describe('worktreeState', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  const commitIn = (dir: string, file: string, body: string): void => {
    writeFileSync(join(dir, file), body)
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'add', '-A'],
      { encoding: 'utf8' }
    )
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-m', body],
      { encoding: 'utf8' }
    )
  }

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wtstate-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    commitIn(repo, 'a.txt', 'one')
  })

  afterAll(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })



  test('once its commits land on the main checkout it is spent', async () => {
    const made = await createWorktree(repo, 'landed')
    if (!made.ok) throw new Error(made.error)
    commitIn(made.path, 'd.txt', 'shipped')
    landInMain(repo, made.branch)

    const state = await worktreeState(repo, made.path, made.branch, made.baseCommit)
    expect(state.ahead).toBe(0)
    expect(state.merged).toBe(true)
  })

  test('uncommitted work always keeps it live, whatever the commits say', async () => {
    const made = await createWorktree(repo, 'landed-but-dirty')
    if (!made.ok) throw new Error(made.error)
    commitIn(made.path, 'e.txt', 'shipped too')
    landInMain(repo, made.branch)
    writeFileSync(join(made.path, 'e.txt'), 'edited after the merge\n')

    const state = await worktreeState(repo, made.path, made.branch, made.baseCommit)
    expect(state.dirty).toBe(1)
    expect(state.merged).toBe(false)
  })

  test('the start point is recovered from the reflog when we have no record', async () => {
    const made = await createWorktree(repo, 'adopted')
    if (!made.ok) throw new Error(made.error)
    commitIn(made.path, 'f.txt', 'adopted work')
    landInMain(repo, made.branch)

    // No baseCommit passed — an adopted worktree has none until git supplies it
    const state = await worktreeState(repo, made.path, made.branch)
    expect(state.merged).toBe(true)
    const listed = await listWorktrees(repo)
    if (!listed.ok) throw new Error(listed.error)
    expect(listed.worktrees.find((w) => w.taskName === 'adopted')?.baseCommit).toBe(
      made.baseCommit
    )
  })

  test('a checkout deleted from disk reports missing, and removal still clears it', async () => {
    const made = await createWorktree(repo, 'vanished')
    if (!made.ok) throw new Error(made.error)
    rmSync(made.path, { recursive: true, force: true })

    const state = await worktreeState(repo, made.path, made.branch, made.baseCommit)
    expect(state.missing).toBe(true)

    const removed = await removeWorktree(repo, made.path, made.branch)
    expect(removed.ok).toBe(true)
    const listed = await listWorktrees(repo)
    if (!listed.ok) throw new Error(listed.error)
    expect(listed.worktrees.some((w) => w.taskName === 'vanished')).toBe(false)
  })
})


// The main checkout is shared by every non-isolated agent, so any of them can
// move HEAD out from under a merge. These are the guards for that.

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
