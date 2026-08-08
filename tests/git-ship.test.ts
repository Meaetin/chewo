import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { invalidBranchName, resolveBase, shipCompare } from '../src/main/git-ship'

/**
 * Only the parts of Ship that are pure git. `shipPreview` and
 * `shipPullRequest` both gate on `gh auth status` and then talk to GitHub, so
 * exercising them here would test the developer's own gh session and open real
 * pull requests — the branch/base plumbing inside them is deliberately not
 * covered.
 */
describe('invalidBranchName', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-ship-name-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  test('accepts the shapes people actually type', async () => {
    expect(await invalidBranchName(repo, 'fix-login')).toBeNull()
    expect(await invalidBranchName(repo, 'feat/add-oauth')).toBeNull()
    expect(await invalidBranchName(repo, 'release/2.1.0')).toBeNull()
    expect(await invalidBranchName(repo, 'martin/WIP_thing')).toBeNull()
  })

  test('rejects what git itself rejects', async () => {
    expect(await invalidBranchName(repo, '')).not.toBeNull()
    expect(await invalidBranchName(repo, '   ')).not.toBeNull()
    expect(await invalidBranchName(repo, 'has space')).not.toBeNull()
    expect(await invalidBranchName(repo, 'a..b')).not.toBeNull()
    expect(await invalidBranchName(repo, 'ends.lock')).not.toBeNull()
    expect(await invalidBranchName(repo, 'tilde~1')).not.toBeNull()
    expect(await invalidBranchName(repo, 'trailing/')).not.toBeNull()
  })

  // `check-ref-format --branch` *expands* these rather than refusing them, so
  // they would sail through as valid and rename to something else entirely
  test('rejects what git would accept by expanding it', async () => {
    expect(await invalidBranchName(repo, '@{-1}')).not.toBeNull()
    expect(await invalidBranchName(repo, '-f')).not.toBeNull()
    expect(await invalidBranchName(repo, '--force')).not.toBeNull()
  })
})

// Retargeting a PR changes which commits it carries, and that is the number
// the modal has to show before you agree to it.
describe('shipCompare', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })
  const commit = (name: string): void => {
    writeFileSync(join(repo, `${name}.txt`), `${name}\n`)
    git('add', '-A')
    git('commit', '-m', name)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-ship-compare-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    commit('initial')
    // develop trails main by one commit, so a branch cut from main carries
    // that extra commit when retargeted at develop
    git('branch', 'develop')
    commit('on-main')
    git('checkout', '-b', 'agent/task')
    commit('the-work')
    git('checkout', 'agent/task')
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  test('counts commits against whichever base is asked for', async () => {
    const vsMain = await shipCompare({ root: repo, base: 'main' })
    if (!vsMain.ok) throw new Error(vsMain.error)
    expect(vsMain.commits.map((c) => c.split(' ').slice(1).join(' '))).toEqual(['the-work'])

    const vsDevelop = await shipCompare({ root: repo, base: 'develop' })
    if (!vsDevelop.ok) throw new Error(vsDevelop.error)
    expect(vsDevelop.commits.map((c) => c.split(' ').slice(1).join(' '))).toEqual([
      'the-work',
      'on-main'
    ])
  })

  test('a base that does not exist is an error, not an empty list', async () => {
    const res = await shipCompare({ root: repo, base: 'no-such-branch' })
    expect(res.ok).toBe(false)
  })
})

// A worktree records its start point as git named it, and Ship has to turn
// that into a branch name GitHub will accept as a PR base.
describe('resolveBase', () => {
  let remote: string
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  beforeAll(() => {
    remote = mkdtempSync(join(homedir(), '.chewo-ship-base-remote-'))
    const seed = mkdtempSync(join(homedir(), '.chewo-ship-base-seed-'))
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    execFileSync('git', ['init', '-b', 'main', seed])
    const at = (dir: string, ...args: string[]): string =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8'
      })
    writeFileSync(join(seed, 'a.txt'), 'one\n')
    at(seed, 'add', '-A')
    at(seed, 'commit', '-m', 'initial')
    // A slashed branch on the remote — the case a naive `origin/` split gets
    // wrong by stopping at the first separator
    at(seed, 'branch', 'dev/updates')
    at(seed, 'remote', 'add', 'origin', remote)
    at(seed, 'push', 'origin', 'main', 'dev/updates')
    rmSync(seed, { recursive: true, force: true })

    repo = mkdtempSync(join(homedir(), '.chewo-ship-base-repo-'))
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['clone', remote, repo])
    // Local-only, never pushed — no use to `gh pr create`
    git('branch', 'local/scratch')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  test('strips the remote from a remote-tracking start point', async () => {
    expect(await resolveBase(repo, 'origin/dev/updates', 'main')).toBe('dev/updates')
    expect(await resolveBase(repo, 'origin/main', 'main')).toBe('main')
  })

  test('leaves a local branch name alone when the remote has it too', async () => {
    expect(await resolveBase(repo, 'dev/updates', 'main')).toBe('dev/updates')
  })

  test('falls back to the default rather than naming a base GitHub cannot see', async () => {
    expect(await resolveBase(repo, 'local/scratch', 'main')).toBe('main')
    expect(await resolveBase(repo, 'no-such-branch', 'main')).toBe('main')
  })

  test('no recorded base means the repo default', async () => {
    expect(await resolveBase(repo, undefined, 'main')).toBe('main')
    expect(await resolveBase(repo, '   ', 'main')).toBe('main')
  })
})
