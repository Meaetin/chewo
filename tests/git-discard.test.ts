import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { discardChanges } from '../src/main/git-discard'

/**
 * Discarding is the one operation here that destroys work on purpose, so every
 * shape of change gets a real repo rather than a mock: the cost of this being
 * subtly wrong is somebody's afternoon.
 */
describe('discardChanges', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })
  const write = (rel: string, text: string): void => {
    const full = join(repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')
  const there = (rel: string): boolean => existsSync(join(repo, rel))
  const status = (): string => git('status', '--porcelain').trim()

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-discard-test-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    write('kept.txt', 'original\n')
    write('src/deep.txt', 'deep original\n')
    write('.gitignore', 'secret.env\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('an unstaged edit goes back to what HEAD says', async () => {
    write('kept.txt', 'agent wrote this\n')
    const res = await discardChanges(repo, ['kept.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual(['kept.txt'])
    expect(read('kept.txt')).toBe('original\n')
    expect(status()).toBe('')
  })

  // Ship stages everything, so a file can be sitting in the index when the
  // panel is looked at. Restoring only the working tree would leave the change
  // staged with a clean tree — invisible in the panel and still shipped.
  test('a staged edit is reverted in the index as well as on disk', async () => {
    write('kept.txt', 'staged change\n')
    git('add', 'kept.txt')
    const res = await discardChanges(repo, ['kept.txt'])
    expect(res.ok).toBe(true)
    expect(read('kept.txt')).toBe('original\n')
    expect(status()).toBe('')
  })

  test('a deleted tracked file comes back', async () => {
    rmSync(join(repo, 'kept.txt'))
    const res = await discardChanges(repo, ['kept.txt'])
    expect(res.ok).toBe(true)
    expect(read('kept.txt')).toBe('original\n')
  })

  test('an untracked file is deleted, since there is nothing to restore', async () => {
    write('scratch.txt', 'never committed\n')
    const res = await discardChanges(repo, ['scratch.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual(['scratch.txt'])
    expect(there('scratch.txt')).toBe(false)
  })

  // `restore --source=HEAD --worktree` cannot be used on a file HEAD has never
  // seen, so this path unstages first and then cleans
  test('a staged new file is unstaged and deleted', async () => {
    write('added.txt', 'brand new\n')
    git('add', 'added.txt')
    const res = await discardChanges(repo, ['added.txt'])
    expect(res.ok).toBe(true)
    expect(there('added.txt')).toBe(false)
    expect(status()).toBe('')
  })

  // git collapses a wholly-untracked directory into one status entry, which
  // the panel shows as one row — so it has to be discardable as one row
  test('a collapsed untracked directory goes as a unit', async () => {
    write('junk/a.txt', 'a\n')
    write('junk/nested/b.txt', 'b\n')
    const res = await discardChanges(repo, ['junk/'])
    expect(res.ok).toBe(true)
    expect(there('junk')).toBe(false)
  })

  // No `-x` on the clean: a discarded folder must not take `.env` with it
  test('ignored files are never touched', async () => {
    write('secret.env', 'API_KEY=1\n')
    write('scratch.txt', 'junk\n')
    const res = await discardChanges(repo, ['scratch.txt'])
    expect(res.ok).toBe(true)
    expect(read('secret.env')).toBe('API_KEY=1\n')
  })

  /**
   * The panel's list is a photograph and several agents write these checkouts
   * at once. A path that is no longer changed must be left alone — restoring
   * it from HEAD would revert whatever happened in between, which is a change
   * nobody was asked about.
   */
  test('a path that is no longer changed is skipped, not restored', async () => {
    write('kept.txt', 'committed since the panel drew it\n')
    git('add', '-A')
    git('commit', '-m', 'second')
    const res = await discardChanges(repo, ['kept.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual([])
    expect(res.skipped).toEqual(['kept.txt'])
    expect(read('kept.txt')).toBe('committed since the panel drew it\n')
  })

  /**
   * A porcelain v1 rename is `R  <new>\0<old>\0` — two NUL records for one
   * entry. A parser that reads every record as a path takes the old name for a
   * separate file, and then classifies the next real entry wrongly.
   */
  test('a rename does not desynchronise the status parse', async () => {
    git('mv', 'kept.txt', 'renamed.txt')
    write('src/deep.txt', 'edited after the rename\n')
    const res = await discardChanges(repo, ['src/deep.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual(['src/deep.txt'])
    expect(read('src/deep.txt')).toBe('deep original\n')
    // The rename is untouched — only the path asked for was discarded
    expect(there('renamed.txt')).toBe(true)
  })

  test('several paths of different kinds in one call', async () => {
    write('kept.txt', 'edited\n')
    write('scratch.txt', 'new\n')
    write('src/deep.txt', 'also edited\n')
    const res = await discardChanges(repo, ['kept.txt', 'scratch.txt', 'src/deep.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded.sort()).toEqual(['kept.txt', 'scratch.txt', 'src/deep.txt'])
    expect(status()).toBe('')
    expect(there('scratch.txt')).toBe(false)
  })

  test('nothing outside the repo, and nothing flag-shaped, is accepted', async () => {
    write('kept.txt', 'edited\n')
    for (const bad of ['../outside.txt', '/etc/passwd', ':(exclude)kept.txt', '--force']) {
      const res = await discardChanges(repo, [bad])
      expect(res.ok, bad).toBe(false)
      expect(res.error, bad).toBe('invalid path')
    }
    // The refusal is total — a bad path in the list stops the whole call
    const mixed = await discardChanges(repo, ['kept.txt', '../outside.txt'])
    expect(mixed.ok).toBe(false)
    expect(read('kept.txt')).toBe('edited\n')
  })

  test('an empty list is a no-op, not an error', async () => {
    const res = await discardChanges(repo, [])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual([])
  })

  test('a path that is not a repo is refused', async () => {
    const plain = mkdtempSync(join(homedir(), '.chewo-discard-plain-'))
    try {
      const res = await discardChanges(plain, ['anything.txt'])
      expect(res.ok).toBe(false)
      expect(res.error).toContain('not a git repository')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

/**
 * The panel expands a collapsed untracked directory into its files and puts a
 * discard button on each one — but `git status -unormal` only ever reports the
 * *directory*, so a lookup by the child's own path finds nothing.
 */
describe('discardChanges inside a collapsed untracked directory', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    })

  beforeEach(() => {
    repo = mkdtempSync(join(homedir(), '.chewo-discard-child-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
    mkdirSync(join(repo, 'junk/nested'), { recursive: true })
    writeFileSync(join(repo, 'junk/a.txt'), 'a\n')
    writeFileSync(join(repo, 'junk/nested/b.txt'), 'b\n')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('one file inside it can be discarded on its own', async () => {
    const res = await discardChanges(repo, ['junk/a.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual(['junk/a.txt'])
    expect(res.skipped).toEqual([])
    expect(existsSync(join(repo, 'junk/a.txt'))).toBe(false)
    // Its siblings are untouched
    expect(existsSync(join(repo, 'junk/nested/b.txt'))).toBe(true)
  })

  test('so can one nested deeper inside it', async () => {
    const res = await discardChanges(repo, ['junk/nested/b.txt'])
    expect(res.ok).toBe(true)
    expect(res.discarded).toEqual(['junk/nested/b.txt'])
    expect(existsSync(join(repo, 'junk/nested/b.txt'))).toBe(false)
    expect(existsSync(join(repo, 'junk/a.txt'))).toBe(true)
  })
})
