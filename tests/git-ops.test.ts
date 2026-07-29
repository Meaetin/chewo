import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { gitBranches, gitCheckout, gitFetch, gitPull, gitPush } from '../src/main/git-ops'

/**
 * Real git throughout — the value of this module is entirely in what git does
 * with the argv it is handed, so a mocked git would test nothing. The repos
 * live in the home directory because every entry point resolves through
 * resolveInsideRoots, and the "remote" is a bare repo on disk so push/pull run
 * without a network or credentials.
 */

const run = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
    { encoding: 'utf8' }
  )

describe('git-ops', () => {
  let repo: string
  let remote: string
  let sibling: string

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-ops-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])

    repo = mkdtempSync(join(homedir(), '.chewo-ops-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '-A')
    run(repo, 'commit', '-m', 'initial')
    run(repo, 'remote', 'add', 'origin', remote)
    run(repo, 'push', '--set-upstream', 'origin', 'main')

    run(repo, 'branch', 'feature')
    // A branch held by a second worktree — git refuses to check it out here
    sibling = `${repo}-sibling`
    run(repo, 'branch', 'held')
    run(repo, 'worktree', 'add', sibling, 'held')
  })

  afterAll(() => {
    rmSync(sibling, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  test('lists local branches with current, upstream and worktree occupancy', async () => {
    const res = await gitBranches(repo)
    if (!res.ok) throw new Error(res.error)
    expect(res.current).toBe('main')

    const names = res.local.map((b) => b.name).sort()
    expect(names).toEqual(['feature', 'held', 'main'])

    const main = res.local.find((b) => b.name === 'main')
    expect(main?.upstream).toBe('origin/main')
    expect(main?.worktree).toBe(repo)

    // The row the menu disables — the branch is checked out somewhere else
    expect(res.local.find((b) => b.name === 'held')?.worktree).toBe(sibling)
    expect(res.local.find((b) => b.name === 'feature')?.worktree).toBeUndefined()

    // origin/HEAD is a symref alias, never an offered start point
    expect(res.remote.some((b) => b.name.endsWith('/HEAD'))).toBe(false)
    expect(res.remote.map((b) => b.name)).toContain('origin/main')
  })

  test('a non-repo path is reported, not thrown', async () => {
    const res = await gitBranches(homedir())
    expect(res.ok).toBe(false)
  })

  test('switches to an existing local branch', async () => {
    const res = await gitCheckout({ root: repo, ref: 'feature' })
    expect(res.ok).toBe(true)
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature')
    await gitCheckout({ root: repo, ref: 'main' })
  })

  test('creates a branch and refuses one that already exists', async () => {
    const made = await gitCheckout({ root: repo, ref: 'brand-new', create: true })
    expect(made.ok).toBe(true)
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('brand-new')

    const again = await gitCheckout({ root: repo, ref: 'brand-new', create: true })
    expect(again.ok).toBe(false)
    await gitCheckout({ root: repo, ref: 'main' })
  })

  test('refuses flag-shaped and malformed refs before git sees them', async () => {
    for (const ref of ['', '  ', '--force', '-d', 'has space']) {
      expect((await gitCheckout({ root: repo, ref })).ok).toBe(false)
    }
    expect((await gitCheckout({ root: repo, ref: 'a..b', create: true })).ok).toBe(false)
  })

  test('a remote-tracking ref checks out a local branch that tracks it', async () => {
    run(repo, 'push', 'origin', 'feature:published')
    run(repo, 'fetch', 'origin')

    const res = await gitCheckout({ root: repo, ref: 'origin/published' })
    if (!res.ok) throw new Error(res.error)
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('published')
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'published@{upstream}').trim()).toBe(
      'origin/published'
    )
    await gitCheckout({ root: repo, ref: 'main' })
  })

  test('a branch another worktree holds comes back as git’s refusal', async () => {
    const res = await gitCheckout({ root: repo, ref: 'held' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/already used by worktree|already checked out/i)
    // Nothing moved
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })

  test('fetch, ff-only pull and push run against the bare remote', async () => {
    expect((await gitFetch(repo)).ok).toBe(true)

    // A commit landing on the remote from elsewhere fast-forwards cleanly
    const other = mkdtempSync(join(homedir(), '.chewo-ops-other-'))
    execFileSync('git', ['clone', remote, other])
    writeFileSync(join(other, 'b.txt'), 'two\n')
    run(other, 'add', '-A')
    run(other, 'commit', '-m', 'from elsewhere')
    run(other, 'push', 'origin', 'main')

    const pulled = await gitPull(repo)
    if (!pulled.ok) throw new Error(pulled.error)
    expect(run(repo, 'log', '-1', '--format=%s').trim()).toBe('from elsewhere')

    writeFileSync(join(repo, 'c.txt'), 'three\n')
    run(repo, 'add', '-A')
    run(repo, 'commit', '-m', 'local work')
    expect((await gitPush({ root: repo })).ok).toBe(true)
    expect(run(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('local work')

    rmSync(other, { recursive: true, force: true })
  })

  test('pull refuses to rewrite history when the branches have diverged', async () => {
    const other = mkdtempSync(join(homedir(), '.chewo-ops-diverge-'))
    execFileSync('git', ['clone', remote, other])
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    run(other, 'add', '-A')
    run(other, 'commit', '-m', 'theirs')
    run(other, 'push', 'origin', 'main')

    writeFileSync(join(repo, 'ours.txt'), 'ours\n')
    run(repo, 'add', '-A')
    run(repo, 'commit', '-m', 'ours')
    const before = run(repo, 'rev-parse', 'HEAD').trim()

    const res = await gitPull(repo)
    expect(res.ok).toBe(false)
    // --ff-only means a divergence is surfaced, never merged or rebased
    expect(run(repo, 'rev-parse', 'HEAD').trim()).toBe(before)

    rmSync(other, { recursive: true, force: true })
  })

  test('publishing an unpushed branch sets its upstream', async () => {
    await gitCheckout({ root: repo, ref: 'unpublished', create: true })
    const res = await gitPush({ root: repo, setUpstream: true })
    if (!res.ok) throw new Error(res.error)
    expect(run(repo, 'rev-parse', '--abbrev-ref', 'unpublished@{upstream}').trim()).toBe(
      'origin/unpublished'
    )
    await gitCheckout({ root: repo, ref: 'main' })
  })
})
