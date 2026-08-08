import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { defaultRemoteRef, gitSwitchBranch, gitUpdateFromBase } from '../src/main/git-ops'
import { createWorktree, removeWorktree } from '../src/main/worktrees'

/**
 * Real git throughout — the value of this module is entirely in what git does
 * with the argv it is handed, so a mocked git would test nothing. The repos
 * live in the home directory because every entry point resolves through
 * resolveInsideRoots, and the "remote" is a bare repo on disk so the fetch
 * runs without a network or credentials.
 */

const run = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
    { encoding: 'utf8' }
  )

const commit = (cwd: string, file: string, body: string, message: string): void => {
  writeFileSync(join(cwd, file), body)
  run(cwd, 'add', '-A')
  run(cwd, 'commit', '-m', message)
}

describe('git-ops', () => {
  let remote: string
  let author: string
  let repo: string

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-ops-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])

    // A second clone that plays "someone else landed a PR"
    author = mkdtempSync(join(homedir(), '.chewo-ops-author-'))
    execFileSync('git', ['init', '-b', 'main', author])
    run(author, 'remote', 'add', 'origin', remote)
    commit(author, 'a.txt', 'one\n', 'initial')
    run(author, 'push', '--set-upstream', 'origin', 'main')

    repo = mkdtempSync(join(homedir(), '.chewo-ops-test-'))
    execFileSync('git', ['clone', remote, repo])
  })

  afterAll(() => {
    for (const d of [repo, author, remote]) rmSync(d, { recursive: true, force: true })
  })

  test('reads the default branch from the clone’s symref, with no network', async () => {
    expect(await defaultRemoteRef(repo)).toBe('origin/main')
  })

  test('falls back to a known name when origin/HEAD was never written', async () => {
    // `git init` + a hand-added remote leaves no symref, which is most repos
    // that were not cloned
    const bare = mkdtempSync(join(homedir(), '.chewo-ops-nohead-'))
    execFileSync('git', ['init', '-b', 'main', bare])
    run(bare, 'remote', 'add', 'origin', remote)
    run(bare, 'fetch', 'origin')
    expect(await defaultRemoteRef(bare)).toBe('origin/main')
    rmSync(bare, { recursive: true, force: true })
  })

  test('on the default branch it fast-forwards to what the remote gained', async () => {
    commit(author, 'b.txt', 'two\n', 'second')
    run(author, 'push')

    const res = await gitUpdateFromBase(repo)
    if (!res.ok) throw new Error(res.error)
    expect(run(repo, 'log', '--oneline')).toContain('second')
  })

  test('on a task branch it merges the default branch in', async () => {
    run(repo, 'switch', '-c', 'agent/task')
    commit(repo, 'mine.txt', 'mine\n', 'my work')

    commit(author, 'c.txt', 'three\n', 'third')
    run(author, 'push')

    const res = await gitUpdateFromBase(repo)
    if (!res.ok) throw new Error(res.error)
    const log = run(repo, 'log', '--oneline')
    // Both histories present, and my own commit was not rewritten
    expect(log).toContain('third')
    expect(log).toContain('my work')
  })

  test('a conflicting merge is aborted, leaving the checkout untouched', async () => {
    // Both sides change the same line
    commit(repo, 'clash.txt', 'branch side\n', 'branch edit')
    const tip = run(repo, 'rev-parse', 'HEAD').trim()

    commit(author, 'clash.txt', 'main side\n', 'main edit')
    run(author, 'push')

    const res = await gitUpdateFromBase(repo)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected a conflict')
    expect(res.error).toContain('aborted')
    // The abort is the point: no MERGE_HEAD, and HEAD never moved
    expect(() => run(repo, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
    expect(run(repo, 'rev-parse', 'HEAD').trim()).toBe(tip)
  })

  test('a repo with no remote is reported, not thrown', async () => {
    const lonely = mkdtempSync(join(homedir(), '.chewo-ops-lonely-'))
    execFileSync('git', ['init', '-b', 'main', lonely])
    commit(lonely, 'a.txt', 'one\n', 'initial')

    const res = await gitUpdateFromBase(lonely)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('No remote')
    rmSync(lonely, { recursive: true, force: true })
  })

  test('a detached HEAD has nothing to update', async () => {
    run(repo, 'checkout', '--detach')
    const res = await gitUpdateFromBase(repo)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Detached')
    run(repo, 'switch', 'agent/task')
  })
})

describe('worktree base selection', () => {
  let remote: string
  let repo: string

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-base-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    const seed = mkdtempSync(join(homedir(), '.chewo-base-seed-'))
    execFileSync('git', ['init', '-b', 'main', seed])
    run(seed, 'remote', 'add', 'origin', remote)
    commit(seed, 'a.txt', 'one\n', 'initial')
    run(seed, 'push', '--set-upstream', 'origin', 'main')
    rmSync(seed, { recursive: true, force: true })

    repo = mkdtempSync(join(homedir(), '.chewo-base-repo-'))
    execFileSync('git', ['clone', remote, repo])
  })

  afterAll(() => {
    for (const d of [repo, remote]) rmSync(d, { recursive: true, force: true })
  })

  test('a new worktree starts from origin when local has nothing extra', async () => {
    const res = await createWorktree(repo, 'from-origin')
    if (!res.ok) throw new Error(res.error)
    expect(res.baseBranch).toBe('origin/main')
    await removeWorktree(repo, res.path, res.branch)
  })

  // The merge modal lands branches into local main and never pushes, so
  // always cutting from origin would hand later sessions a stale checkout
  test('an unpushed local merge wins over origin', async () => {
    commit(repo, 'landed.txt', 'merged locally\n', 'landed without pushing')
    const res = await createWorktree(repo, 'from-local')
    if (!res.ok) throw new Error(res.error)
    expect(res.baseBranch).toBe('main')
    expect(run(res.path, 'log', '--oneline')).toContain('landed without pushing')
    await removeWorktree(repo, res.path, res.branch)
  })
})

/**
 * The narrow branch switch that puts a checkout stranded on merged work back
 * on its default branch. Everything about it is what it *cannot* do.
 */
describe('gitSwitchBranch', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-switch-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    commit(repo, 'a.txt', 'one\n', 'initial')
    run(repo, 'branch', 'other')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('moves HEAD onto an existing branch', async () => {
    run(repo, 'switch', '-q', 'other')
    const res = await gitSwitchBranch(repo, 'main')
    expect(res.ok).toBe(true)
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })

  test('never creates a branch — an unknown name is a refusal, not a new ref', async () => {
    const res = await gitSwitchBranch(repo, 'no-such-branch')
    expect(res.ok).toBe(false)
    expect(run(repo, 'branch', '--format=%(refname:short)')).not.toContain('no-such-branch')
  })

  test('flag-shaped names never reach git argv', async () => {
    expect(await gitSwitchBranch(repo, '--detach')).toEqual({
      ok: false,
      error: 'Not a valid branch name'
    })
    expect(await gitSwitchBranch(repo, '  ')).toEqual({
      ok: false,
      error: 'Not a valid branch name'
    })
    // -c would have made a branch rather than moved to one
    expect(await gitSwitchBranch(repo, '-c')).toEqual({
      ok: false,
      error: 'Not a valid branch name'
    })
  })
})
