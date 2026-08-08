import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_LOCAL_FILES } from '../src/shared/local-files'
import {
  branchFor,
  cloneNodeModules,
  copyLocalFiles,
  createWorktree,
  listBranches,
  listWorktrees,
  pruneCandidates,
  pruneMergedBranches,
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

// A cloned repo is where the picker's two mislabelling bugs lived, and a
// `git init` fixture cannot reach either: it has no `origin/HEAD`, and its
// branch names have no slashes.
describe('listBranches on a clone', () => {
  let origin: string
  let repo: string

  const git = (dir: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    origin = mkdtempSync(join(homedir(), '.chewo-lb-origin-'))
    execFileSync('git', ['init', '-b', 'main', origin])
    writeFileSync(join(origin, 'a.txt'), 'one\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-m', 'initial')

    repo = mkdtempSync(join(homedir(), '.chewo-lb-clone-'))
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', origin, repo])
    git(repo, 'branch', 'agent/some-task')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  })

  test('a local branch with a slash is local, not remote', async () => {
    const res = await listBranches(repo)
    if (!res.ok) throw new Error(res.error)
    // `main` is absent by design — see the local-twin test below
    expect(res.local.sort()).toEqual(['agent/some-task'])
    expect(res.remote).toEqual(['origin/main'])
  })

  test('the origin/HEAD symref is not offered as a base', async () => {
    const res = await listBranches(repo)
    if (!res.ok) throw new Error(res.error)
    // git renders `refs/remotes/origin/HEAD` as bare `origin`, so it looks like
    // a local branch to anything matching on the short name
    expect([...res.local, ...res.remote]).not.toContain('origin')
  })
})

// The picker offers `origin/main` as its default row, so an unmoved local
// `main` beside it is one start point wearing two names. It is dropped on
// commit equality only — this fixture mutates, hence its own clone.
describe('listBranches drops the default base local twin', () => {
  let origin: string
  let repo: string

  const git = (dir: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    origin = mkdtempSync(join(homedir(), '.chewo-twin-origin-'))
    execFileSync('git', ['init', '-b', 'main', origin])
    writeFileSync(join(origin, 'a.txt'), 'one\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-m', 'initial')

    repo = mkdtempSync(join(homedir(), '.chewo-twin-clone-'))
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', origin, repo])
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  })

  test('a local main that has not moved is not offered', async () => {
    const res = await listBranches(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.local).not.toContain('main')
    expect(res.remote).toContain('origin/main')
    // Dropping it from the list must not lose what the checkout is standing on
    expect(res.current).toBe('main')
  })

  test('a local main holding unpushed commits is a real start point again', async () => {
    writeFileSync(join(repo, 'b.txt'), 'two\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'local only')
    const res = await listBranches(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.local).toContain('main')
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

// A named remote base is a *cache* of somebody else's branch. Cutting from it
// unfetched means "as of whenever this repo last heard", which is the exact
// staleness a fresh worktree exists to avoid.
describe('a chosen remote base is fetched before the branch is cut', () => {
  let repo: string
  let remote: string
  let other: string

  const at = (dir: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-wt-base-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    repo = mkdtempSync(join(homedir(), '.chewo-wt-base-repo-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    at(repo, 'add', '-A')
    at(repo, 'commit', '-m', 'initial')
    at(repo, 'remote', 'add', 'origin', remote)
    at(repo, 'push', '-u', 'origin', 'main')
    at(repo, 'push', 'origin', 'main:refs/heads/feature')
    at(repo, 'fetch', 'origin')

    // Somebody else moves `feature` on the remote. Our repo has not fetched
    // since, so `origin/feature` on disk still points at the old commit.
    other = mkdtempSync(join(homedir(), '.chewo-wt-base-other-'))
    execFileSync('git', ['clone', remote, other])
    writeFileSync(join(other, 'b.txt'), 'two\n')
    at(other, 'checkout', 'feature')
    at(other, 'add', '-A')
    at(other, 'commit', '-m', 'landed after our last fetch')
    at(other, 'push', 'origin', 'feature')
  })

  afterAll(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    for (const dir of [repo, remote, other]) rmSync(dir, { recursive: true, force: true })
  })

  test('the worktree lands on the remote tip, not the cached one', async () => {
    const stale = at(repo, 'rev-parse', 'origin/feature').trim()
    const res = await createWorktree(repo, 'follow-on', 'origin/feature')
    if (!res.ok) throw new Error(res.error)
    const tip = at(repo, 'rev-parse', res.branch).trim()
    expect(tip).not.toBe(stale)
    expect(tip).toBe(at(other, 'rev-parse', 'feature').trim())
    expect(res.baseCommit).toBe(tip)
    // The checkout itself, not just the ref: the agent opens onto that work
    expect(existsSync(join(res.path, 'b.txt'))).toBe(true)
  })

  test('a local base is cut as it stands', async () => {
    at(repo, 'branch', 'local-only')
    const res = await createWorktree(repo, 'off-local', 'local-only')
    if (!res.ok) throw new Error(res.error)
    expect(res.baseCommit).toBe(at(repo, 'rev-parse', 'local-only').trim())
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

// Only git knows which files it ignores, so the candidate list has to come
// from a real repo — a hand-rolled walk is exactly what this avoids.
describe('copyLocalFiles', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wtcopy-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, '.gitignore'), '.env*\n!.env.example\nnode_modules/\ndist/\n')
    writeFileSync(join(repo, '.env.example'), 'API_KEY=\n')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
    // The machine-local files a fresh checkout will not have
    writeFileSync(join(repo, '.env'), 'API_KEY=real\n')
    writeFileSync(join(repo, '.env.local'), 'OVERRIDE=1\n')
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'web', '.env'), 'PORT=3000\n')
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), '//\n')
    mkdirSync(join(repo, 'dist'), { recursive: true })
    writeFileSync(join(repo, 'dist', 'bundle.js'), '//\n')
  })

  afterEach(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('the defaults carry every env file across, at any depth', async () => {
    const made = await createWorktree(repo, 'copy')
    if (!made.ok) throw new Error(made.error)

    const res = await copyLocalFiles(repo, made.path, DEFAULT_LOCAL_FILES)
    expect(res.error).toBeUndefined()
    expect(res.copied.sort()).toEqual(['.env', '.env.local', 'apps/web/.env'])
    expect(readFileSync(join(made.path, '.env'), 'utf8')).toBe('API_KEY=real\n')
    expect(readFileSync(join(made.path, 'apps', 'web', '.env'), 'utf8')).toBe('PORT=3000\n')
  })

  test('build output and dependencies are left where they are', async () => {
    const made = await createWorktree(repo, 'skips')
    if (!made.ok) throw new Error(made.error)

    await copyLocalFiles(repo, made.path, DEFAULT_LOCAL_FILES)
    expect(existsSync(join(made.path, 'dist'))).toBe(false)
    expect(existsSync(join(made.path, 'node_modules'))).toBe(false)
  })

  test('node_modules is never copied here however broad the pattern', async () => {
    const made = await createWorktree(repo, 'greedy')
    if (!made.ok) throw new Error(made.error)

    const res = await copyLocalFiles(repo, made.path, ['*'])
    expect(existsSync(join(made.path, 'node_modules'))).toBe(false)
    expect(res.copied).toContain('dist/')
  })

  test('a tracked file already in the checkout is never overwritten', async () => {
    const made = await createWorktree(repo, 'tracked')
    if (!made.ok) throw new Error(made.error)
    writeFileSync(join(repo, '.env.example'), 'TAMPERED=1\n')

    const res = await copyLocalFiles(repo, made.path, ['.env.example'])
    expect(res.copied).toEqual([])
    expect(readFileSync(join(made.path, '.env.example'), 'utf8')).toBe('API_KEY=\n')
  })

  test('directories named by a pattern come across whole', async () => {
    mkdirSync(join(repo, '.certs'), { recursive: true })
    writeFileSync(join(repo, '.certs', 'dev.pem'), 'PEM\n')
    writeFileSync(join(repo, '.gitignore'), '.env*\n!.env.example\nnode_modules/\n.certs/\n')
    const made = await createWorktree(repo, 'certs')
    if (!made.ok) throw new Error(made.error)

    const res = await copyLocalFiles(repo, made.path, ['.certs'])
    expect(res.copied).toEqual(['.certs/'])
    expect(readFileSync(join(made.path, '.certs', 'dev.pem'), 'utf8')).toBe('PEM\n')
  })

  // The safety argument for the whole feature: only files git will keep
  // ignoring travel, so Ship's `git add -A` can never stage what this copied.
  test('a file git does not ignore is not a candidate, however it is named', async () => {
    writeFileSync(join(repo, 'local.config.json'), '{}\n')
    const made = await createWorktree(repo, 'untracked')
    if (!made.ok) throw new Error(made.error)

    const res = await copyLocalFiles(repo, made.path, ['local.config.json', '*'])
    expect(res.copied).not.toContain('local.config.json')
    expect(existsSync(join(made.path, 'local.config.json'))).toBe(false)
  })
})

// The pane is already open while this runs, so a partially-filled
// `node_modules` is something the session can genuinely catch in the act.
describe('cloneNodeModules', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-wtclone-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'add', '-A'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'i'])
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), '//\n')
  })

  afterEach(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('the tree arrives whole, and nothing is left beside the worktree', async () => {
    const made = await createWorktree(repo, 'deps')
    if (!made.ok) throw new Error(made.error)

    expect(await cloneNodeModules(repo, made.path)).toBeNull()
    expect(readFileSync(join(made.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('//\n')
    expect(readdirSync(dirname(made.path)).filter((n) => n.includes('staged'))).toEqual([])
  })

  test('an install that won the race keeps its own tree', async () => {
    const made = await createWorktree(repo, 'raced')
    if (!made.ok) throw new Error(made.error)
    // Stand in for `npm install` finishing while the copy was still running
    mkdirSync(join(made.path, 'node_modules', 'installed'), { recursive: true })

    expect(await cloneNodeModules(repo, made.path)).toBeNull()
    expect(existsSync(join(made.path, 'node_modules', 'installed'))).toBe(true)
    expect(existsSync(join(made.path, 'node_modules', 'left-pad'))).toBe(false)
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

// The reaper's other half. `reapMerged` walks Worktree *records*, so a branch
// whose record drifted away — or that was made in a terminal and never had one
// — is invisible to it and accumulates forever. This sweeps those, and every
// guard below is what makes it safe to run unattended on window focus.
describe('pruneMergedBranches', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  const commitOn = (branch: string, file: string): void => {
    git('checkout', '-q', '-b', branch)
    writeFileSync(join(repo, file), `${file}\n`)
    git('add', '-A')
    git('commit', '-q', '-m', file)
    git('checkout', '-q', 'main')
  }

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-prune-test-'))
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
  })

  afterEach(() => {
    rmSync(join(WORKTREES_ROOT, basename(repo)), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('deletes a merged branch that has no worktree left', async () => {
    commitOn('agent/landed', 'b.txt')
    landInMain(repo, 'agent/landed')

    expect(await pruneMergedBranches(repo, ['agent/landed'])).toEqual(['agent/landed'])
    expect(git('branch', '--format=%(refname:short)')).not.toContain('agent/landed')
  })

  // A squash or rebase merge rewrites SHAs, so git cannot see the branch as
  // merged and refuses — the same blind spot worktreeState has, and the reason
  // this is safe to run with nobody watching.
  test('keeps a branch git cannot see as merged, even when the PR says merged', async () => {
    commitOn('agent/squashed', 'c.txt')

    expect(await pruneMergedBranches(repo, ['agent/squashed'])).toEqual([])
    expect(git('branch', '--format=%(refname:short)')).toContain('agent/squashed')
  })

  test('never deletes a branch checked out in a worktree', async () => {
    const res = await createWorktree(repo, 'live')
    if (!res.ok) throw new Error(res.error)
    landInMain(repo, branchFor('live'))

    // Merged and record-less, so only the checkout itself is holding it
    expect(await pruneMergedBranches(repo, [branchFor('live')])).toEqual([])
    expect(git('branch', '--format=%(refname:short)')).toContain(branchFor('live'))
  })

  test('never deletes the branch HEAD is on', async () => {
    expect(await pruneMergedBranches(repo, ['main'])).toEqual([])
    expect(git('branch', '--format=%(refname:short)')).toContain('main')
  })

  // The guard that earns its place: once you are ahead of the default branch,
  // it *is* merged into HEAD, so plain `-d` would happily delete it.
  test('never deletes the remote default branch, even from a branch ahead of it', async () => {
    const origin = mkdtempSync(join(homedir(), '.chewo-prune-origin-'))
    rmSync(origin, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', repo, origin])
    const clone = (...args: string[]): string =>
      execFileSync('git', ['-C', origin, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8'
      })
    try {
      clone('checkout', '-q', '-b', 'work')
      writeFileSync(join(origin, 'd.txt'), 'd\n')
      clone('add', '-A')
      clone('commit', '-q', '-m', 'ahead')

      expect(await pruneMergedBranches(origin, ['main'])).toEqual([])
      expect(clone('branch', '--format=%(refname:short)')).toContain('main')
    } finally {
      rmSync(origin, { recursive: true, force: true })
    }
  })

  test('ignores names that are not local branches, and an empty list', async () => {
    expect(await pruneMergedBranches(repo, [])).toEqual([])
    expect(await pruneMergedBranches(repo, ['never-existed', 'origin/main'])).toEqual([])
  })
})

// The gate that keeps the sweep off the network: `reapMerged` asks every
// project, so a repo with nothing to clean must be ruled out locally before a
// `gh pr list` is spent on it.
describe('pruneCandidates', () => {
  let repo: string
  let clone: string

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  beforeEach(() => {
    // Bare: a non-bare origin refuses a push to the branch it has checked out,
    // and these tests land work on origin/main to make a branch prunable
    repo = mkdtempSync(join(homedir(), '.chewo-cand-origin-'))
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', repo])

    const seed = mkdtempSync(join(homedir(), '.chewo-cand-seed-'))
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    writeFileSync(join(seed, 'a.txt'), 'one\n')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'initial')
    git(seed, 'remote', 'add', 'origin', repo)
    git(seed, 'push', '-q', '-u', 'origin', 'main')
    rmSync(seed, { recursive: true, force: true })

    clone = mkdtempSync(join(homedir(), '.chewo-cand-clone-'))
    rmSync(clone, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', repo, clone])
  })

  afterEach(() => {
    rmSync(join(WORKTREES_ROOT, basename(clone)), { recursive: true, force: true })
    rmSync(clone, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('a repo holding only its default branch has nothing to offer', async () => {
    expect(await pruneCandidates(clone)).toEqual([])
  })

  test('live work is not a candidate, so an active repo costs no gh call', async () => {
    git(clone, 'checkout', '-q', '-b', 'wip')
    writeFileSync(join(clone, 'b.txt'), 'b\n')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'wip')
    git(clone, 'checkout', '-q', 'main')

    expect(await pruneCandidates(clone)).toEqual([])
  })

  test('a landed branch with no checkout is offered', async () => {
    git(clone, 'checkout', '-q', '-b', 'agent/landed')
    writeFileSync(join(clone, 'c.txt'), 'c\n')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'c')
    git(clone, 'checkout', '-q', 'main')
    git(clone, 'merge', '-q', '--no-ff', '--no-edit', 'agent/landed')
    git(clone, 'push', '-q', 'origin', 'main')
    git(clone, 'fetch', '-q', 'origin')

    expect(await pruneCandidates(clone)).toEqual(['agent/landed'])
  })

  test('never offers a branch held by a worktree, or the default branch', async () => {
    const res = await createWorktree(clone, 'live')
    if (!res.ok) throw new Error(res.error)
    git(clone, 'merge', '-q', '--no-ff', '--no-edit', branchFor('live'))
    git(clone, 'push', '-q', 'origin', 'main')
    git(clone, 'fetch', '-q', 'origin')

    const offered = await pruneCandidates(clone)
    expect(offered).not.toContain(branchFor('live'))
    expect(offered).not.toContain('main')
  })

  test('a repo with no remote default has no notion of landed', async () => {
    const solo = mkdtempSync(join(homedir(), '.chewo-cand-solo-'))
    execFileSync('git', ['init', '-q', '-b', 'main', solo])
    writeFileSync(join(solo, 'a.txt'), 'one\n')
    git(solo, 'add', '-A')
    git(solo, 'commit', '-q', '-m', 'initial')
    git(solo, 'branch', 'spare')
    try {
      expect(await pruneCandidates(solo)).toEqual([])
    } finally {
      rmSync(solo, { recursive: true, force: true })
    }
  })
})
