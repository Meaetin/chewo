import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  gitCommitDetail,
  gitDiff,
  gitLog,
  gitStatus,
  gitUntrackedFiles,
  gitWatchIgnored
} from '../src/main/git'
import { parseDiff, unwrapCommitBody } from '../src/renderer/src/components/GitDiffView'

// Real git against a scratch repo. It must live under an allowed root
// (resolveInsideRoots), so it goes in the home directory like the worktrees.
let repo: string

const git = (...args: string[]): string =>
  execFileSync(
    'git',
    ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args],
    { encoding: 'utf8' }
  )

beforeAll(() => {
  repo = mkdtempSync(join(homedir(), '.chewo-git-test-'))
  execFileSync('git', ['init', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'with space.txt'), 'hello\n')
  git('add', '-A')
  git('commit', '-m', 'initial commit')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('gitStatus', () => {
  test('clean repo reports branch and empty file list', async () => {
    const s = await gitStatus(repo)
    if (!s.ok || !s.isRepo) throw new Error('expected repo status')
    expect(s.branch).toBe('main')
    expect(s.detached).toBe(false)
    expect(s.upstream).toBeNull()
    expect(s.headOid).toMatch(/^[0-9a-f]{40}$/)
    expect(s.files).toEqual([])
  })

  test('modified, untracked, staged-add and paths with spaces all parse', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    writeFileSync(join(repo, 'with space.txt'), 'hello\nworld\n')
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    git('add', 'staged.txt')

    const s = await gitStatus(repo)
    if (!s.ok || !s.isRepo) throw new Error('expected repo status')
    const byPath = new Map(s.files.map((f) => [f.path, f]))

    const a = byPath.get('a.txt')
    expect(a?.status).toBe('M')
    expect(a?.unstaged).toBe(true)
    expect(a?.additions).toBe(2)
    expect(a?.deletions).toBe(1)

    const spaced = byPath.get('with space.txt')
    expect(spaced?.status).toBe('M')
    expect(spaced?.additions).toBe(1)

    expect(byPath.get('new.txt')?.status).toBe('?')
    expect(byPath.get('new.txt')?.additions).toBeNull()

    const staged = byPath.get('staged.txt')
    expect(staged?.status).toBe('A')
    expect(staged?.staged).toBe(true)

    // reset for later tests
    git('checkout', '--', 'a.txt', 'with space.txt')
    git('reset', '--', 'staged.txt')
    rmSync(join(repo, 'staged.txt'))
  })

  test('staged rename carries origPath', async () => {
    git('mv', 'a.txt', 'renamed.txt')
    const s = await gitStatus(repo)
    if (!s.ok || !s.isRepo) throw new Error('expected repo status')
    const r = s.files.find((f) => f.status === 'R')
    expect(r?.path).toBe('renamed.txt')
    expect(r?.origPath).toBe('a.txt')
    git('mv', 'renamed.txt', 'a.txt')
  })

  test('a wholly-untracked directory collapses into one isDir entry', async () => {
    mkdirSync(join(repo, 'pkg/src'), { recursive: true })
    writeFileSync(join(repo, 'pkg/one.txt'), 'one\n')
    writeFileSync(join(repo, 'pkg/src/two.txt'), 'two\n')

    const s = await gitStatus(repo)
    if (!s.ok || !s.isRepo) throw new Error('expected repo status')
    const entries = s.files.filter((f) => f.path.startsWith('pkg'))
    // git reports the directory, not its files — trailing slash and all
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('pkg/')
    expect(entries[0].status).toBe('?')
    expect(entries[0].isDir).toBe(true)
  })

  test('a regular untracked file is not marked isDir', async () => {
    writeFileSync(join(repo, 'loose.txt'), 'loose\n')
    const s = await gitStatus(repo)
    if (!s.ok || !s.isRepo) throw new Error('expected repo status')
    expect(s.files.find((f) => f.path === 'loose.txt')?.isDir).toBeUndefined()
    rmSync(join(repo, 'loose.txt'))
  })

  test('a non-repo directory reports isRepo false', async () => {
    const outside = mkdtempSync(join(homedir(), '.chewo-git-test-plain-'))
    try {
      const s = await gitStatus(outside)
      expect(s).toEqual({ ok: true, isRepo: false })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('gitLog + gitCommitDetail', () => {
  test('log lists commits newest-first with HEAD decoration', async () => {
    writeFileSync(join(repo, 'b.txt'), 'bee\n')
    git('add', 'b.txt')
    git('commit', '-m', 'add b')

    const log = await gitLog(repo)
    if (!log.ok) throw new Error(log.error)
    expect(log.commits.length).toBe(2)
    expect(log.commits[0].subject).toBe('add b')
    expect(log.commits[1].subject).toBe('initial commit')
    expect(log.commits[0].refs.some((r) => r.startsWith('HEAD'))).toBe(true)
    expect(log.commits[0].shortHash.length).toBeGreaterThanOrEqual(7)
  })

  test('commit detail lists files with letters and line counts', async () => {
    const log = await gitLog(repo)
    if (!log.ok) throw new Error(log.error)
    const head = log.commits[0]

    const d = await gitCommitDetail(repo, head.hash)
    if (!d.ok) throw new Error(d.error)
    expect(d.meta.subject).toBe('add b')
    expect(d.files).toEqual([
      { path: 'b.txt', status: 'A', additions: 1, deletions: 0 }
    ])
  })

  test('root commit detail works (--root)', async () => {
    const log = await gitLog(repo)
    if (!log.ok) throw new Error(log.error)
    const first = log.commits[log.commits.length - 1]
    const d = await gitCommitDetail(repo, first.hash)
    if (!d.ok) throw new Error(d.error)
    expect(d.files.map((f) => f.path).sort()).toEqual(['a.txt', 'with space.txt'])
    expect(d.files.every((f) => f.status === 'A')).toBe(true)
  })

  test('rejects a malformed hash', async () => {
    const d = await gitCommitDetail(repo, '$(rm -rf /)')
    expect(d.ok).toBe(false)
  })
})

describe('gitDiff', () => {
  test('worktree diff for a modified file', async () => {
    writeFileSync(join(repo, 'b.txt'), 'bee\nboo\n')
    const d = await gitDiff(repo, { kind: 'worktree', path: 'b.txt', untracked: false })
    if (!d.ok) throw new Error(d.error)
    expect(d.text).toContain('@@')
    expect(d.text).toContain('+boo')
    git('checkout', '--', 'b.txt')
  })

  test('untracked file diffs against /dev/null', async () => {
    writeFileSync(join(repo, 'newfile.txt'), 'alpha\nbeta\n')
    const d = await gitDiff(repo, { kind: 'worktree', path: 'newfile.txt', untracked: true })
    if (!d.ok) throw new Error(d.error)
    expect(d.text).toContain('+alpha')
    expect(d.text).toContain('+beta')
    rmSync(join(repo, 'newfile.txt'))
  })

  test('an untracked directory reports a folder notice, not git stderr', async () => {
    // --no-index given /dev/null and a directory looks for `<dir>/null` inside
    // it and fails; the panel expands the folder instead of diffing it
    const d = await gitDiff(repo, { kind: 'worktree', path: 'pkg/', untracked: true })
    expect(d.ok).toBe(false)
    if (d.ok) throw new Error('expected failure')
    expect(d.error).not.toContain('null')
    expect(d.error).toContain('New folder')
  })

  test('commit diff for one file', async () => {
    const log = await gitLog(repo)
    if (!log.ok) throw new Error(log.error)
    const d = await gitDiff(repo, { kind: 'commit', hash: log.commits[0].hash, path: 'b.txt' })
    if (!d.ok) throw new Error(d.error)
    expect(d.text).toContain('+bee')
  })
})

describe('gitUntrackedFiles', () => {
  test('lists the files inside a collapsed directory, recursively', async () => {
    const r = await gitUntrackedFiles(repo, 'pkg/')
    if (!r.ok) throw new Error(r.error)
    expect(r.paths).toEqual(['pkg/one.txt', 'pkg/src/two.txt'])
    expect(r.total).toBe(2)
  })

  test('honours .gitignore inside the directory', async () => {
    mkdirSync(join(repo, 'pkg/.build'), { recursive: true })
    writeFileSync(join(repo, 'pkg/.build/junk.o'), 'binary-ish\n')
    writeFileSync(join(repo, 'pkg/.gitignore'), '.build/\n')

    const r = await gitUntrackedFiles(repo, 'pkg/')
    if (!r.ok) throw new Error(r.error)
    expect(r.paths).toContain('pkg/.gitignore')
    expect(r.paths.some((p) => p.includes('.build'))).toBe(false)
  })

  test('rejects traversal and pathspec magic', async () => {
    for (const bad of ['../elsewhere', '/etc', ':(exclude)pkg', 'pkg/../../out', '']) {
      const r = await gitUntrackedFiles(repo, bad)
      expect(r).toEqual({ ok: false, error: 'invalid path' })
    }
  })
})

describe('parseDiff', () => {
  test('tracks line numbers through hunks', () => {
    const text = [
      'diff --git a/x b/x',
      'index 000..111 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      '+extra',
      ' three'
    ].join('\n')
    const { lines, binary } = parseDiff(text)
    expect(binary).toBe(false)
    expect(lines.map((l) => [l.type, l.no])).toEqual([
      ['hunk', null],
      ['ctx', 1],
      ['del', 2],
      ['add', 2],
      ['add', 3],
      ['ctx', 4]
    ])
  })

  test('flags binary diffs', () => {
    expect(parseDiff('Binary files a/i.png and b/i.png differ').binary).toBe(true)
  })
})

describe('unwrapCommitBody', () => {
  test('joins hard-wrapped paragraphs, keeps lists and paragraph breaks', () => {
    const body =
      'First paragraph wrapped\nat seventy-two columns\nby git.\n\n- item one\n- item two\n\nSecond para\nalso wrapped.'
    expect(unwrapCommitBody(body)).toBe(
      'First paragraph wrapped at seventy-two columns by git.\n\n- item one\n- item two\n\nSecond para also wrapped.'
    )
  })

  test('drops a trailing trailer block, keeps prose that merely contains colons', () => {
    expect(unwrapCommitBody('Real prose here.\n\nCo-Authored-By: X <x@y>\nSigned-off-by: Z <z@y>')).toBe(
      'Real prose here.'
    )
    expect(unwrapCommitBody('Note: this whole body is prose.')).toBe(
      'Note: this whole body is prose.'
    )
  })
})

describe('gitWatchIgnored', () => {
  const R = '/Users/t/proj'

  test('working-tree files wake the panel', () => {
    for (const p of [`${R}/src/index.ts`, `${R}/README.md`, `${R}/a b/c.txt`]) {
      expect(gitWatchIgnored(p)).toBe(false)
    }
  })

  test('node_modules is dropped at any depth, but a lookalike name is not', () => {
    expect(gitWatchIgnored(`${R}/node_modules/react/index.js`)).toBe(true)
    expect(gitWatchIgnored(`${R}/packages/x/node_modules/y/z.js`)).toBe(true)
    expect(gitWatchIgnored(`${R}/node_modules`)).toBe(true)
    expect(gitWatchIgnored(`${R}/node_modules_notes.md`)).toBe(false)
  })

  test('.git object churn is dropped, state-moving entries are kept', () => {
    expect(gitWatchIgnored(`${R}/.git/objects/ab/cdef`)).toBe(true)
    expect(gitWatchIgnored(`${R}/.git/logs/HEAD`)).toBe(true)
    for (const keep of ['HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'index', 'packed-refs', 'refs/heads/main']) {
      expect(gitWatchIgnored(`${R}/.git/${keep}`)).toBe(false)
    }
  })

  test('.gitignore is a tracked file, not a .git internal', () => {
    expect(gitWatchIgnored(`${R}/.gitignore`)).toBe(false)
    expect(gitWatchIgnored(`${R}/.gitattributes`)).toBe(false)
    expect(gitWatchIgnored(`${R}/src/.gitkeep`)).toBe(false)
  })
})
