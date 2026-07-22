import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { resolveInsideRoots } from './file-explorer'
import { safeSend } from './safe-send'

/**
 * Read-only git visibility for the git panel: status, history, diffs, plus a
 * per-repo change watcher. Nothing here stages, commits or mutates a repo.
 * Multiple agents work these repos concurrently, so results are never cached —
 * every call re-reads from git, and parsing sticks to plumbing formats
 * (--porcelain=v2, -z, %x1f) that are stable across git versions and locales.
 */

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      // Never let a credential prompt hang a non-interactive call
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

export const gitErrorOf = (r: GitResult): string =>
  r.stderr.trim() || r.stdout.trim() || 'git failed'

const NOT_A_REPO = /not a git repository/i
const NO_COMMITS = /does not have any commits yet|bad default revision|unknown revision/i

// ---------- status ----------

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface ChangedFile {
  /** Repo-relative path (rename target for renames) */
  path: string
  /** Rename/copy source */
  origPath?: string
  status: FileStatus
  staged: boolean
  unstaged: boolean
  /** Line counts vs HEAD; null for untracked or binary files */
  additions: number | null
  deletions: number | null
}

export type RepoStatus =
  | {
      ok: true
      isRepo: true
      /** Short branch name, or abbreviated oid when detached */
      branch: string
      detached: boolean
      upstream: string | null
      ahead: number
      behind: number
      /** HEAD commit id — null before the first commit. History refetches when it moves. */
      headOid: string | null
      files: ChangedFile[]
    }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

/** `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — path starts at field 8 */
const ORDINARY_PATH_FIELD = 8
/** `2` adds an `<X><score>` field before the path */
const RENAME_PATH_FIELD = 9
/** `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` */
const UNMERGED_PATH_FIELD = 10

function statusLetter(record: '1' | '2' | 'u', xy: string): FileStatus {
  if (record === 'u') return 'U'
  const x = xy[0]
  const y = xy[1]
  if (record === '2') return x === 'C' || y === 'C' ? 'C' : 'R'
  const c = y !== '.' ? y : x
  return c === 'M' || c === 'A' || c === 'D' || c === 'T' ? c : 'M'
}

/** Parse `git diff --numstat -z` output into path → {additions, deletions}. */
function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>()
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i])
    if (!m) continue
    // Renames put an empty path in the record; source and target follow as
    // their own NUL-separated tokens
    const path = m[3] !== '' ? m[3] : tokens[(i += 2)]
    if (path === undefined) break
    map.set(path, {
      additions: m[1] === '-' ? null : Number(m[1]),
      deletions: m[2] === '-' ? null : Number(m[2])
    })
  }
  return map
}

export async function gitStatus(root: string): Promise<RepoStatus> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }

  const res = await runGit(real, ['status', '--porcelain=v2', '--branch', '-z'])
  if (!res.ok) {
    if (NOT_A_REPO.test(res.stderr)) return { ok: true, isRepo: false }
    return { ok: false, error: gitErrorOf(res) }
  }

  let branch = ''
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let headOid: string | null = null
  const files: ChangedFile[] = []

  const tokens = res.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '') continue
    if (t.startsWith('# branch.oid ')) {
      const oid = t.slice('# branch.oid '.length)
      headOid = oid === '(initial)' ? null : oid
    } else if (t.startsWith('# branch.head ')) {
      const head = t.slice('# branch.head '.length)
      detached = head === '(detached)'
      branch = head
    } else if (t.startsWith('# branch.upstream ')) {
      upstream = t.slice('# branch.upstream '.length)
    } else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (t.startsWith('1 ')) {
      const parts = t.split(' ')
      const xy = parts[1]
      files.push({
        path: parts.slice(ORDINARY_PATH_FIELD).join(' '),
        status: statusLetter('1', xy),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        additions: null,
        deletions: null
      })
    } else if (t.startsWith('2 ')) {
      const parts = t.split(' ')
      const xy = parts[1]
      files.push({
        path: parts.slice(RENAME_PATH_FIELD).join(' '),
        origPath: tokens[++i],
        status: statusLetter('2', xy),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        additions: null,
        deletions: null
      })
    } else if (t.startsWith('u ')) {
      const parts = t.split(' ')
      files.push({
        path: parts.slice(UNMERGED_PATH_FIELD).join(' '),
        status: 'U',
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null
      })
    } else if (t.startsWith('? ')) {
      files.push({
        path: t.slice(2),
        status: '?',
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null
      })
    }
  }

  if (detached && headOid) branch = headOid.slice(0, 7)

  // Line stats vs HEAD (staged + unstaged in one pass); untracked files have none
  if (headOid && files.some((f) => f.status !== '?')) {
    const numstat = await runGit(real, ['diff', '--numstat', '-z', '--find-renames', 'HEAD'])
    if (numstat.ok) {
      const stats = parseNumstat(numstat.stdout)
      for (const f of files) {
        const s = stats.get(f.path)
        if (s) {
          f.additions = s.additions
          f.deletions = s.deletions
        }
      }
    }
  }

  return { ok: true, isRepo: true, branch, detached, upstream, ahead, behind, headOid, files }
}

// ---------- history ----------

export interface CommitMeta {
  hash: string
  shortHash: string
  author: string
  /** Unix seconds */
  time: number
  subject: string
  /** Decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0" */
  refs: string[]
}

export type LogResult = { ok: true; commits: CommitMeta[] } | { ok: false; error: string }

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ct%x1f%D%x1f%s%x1e'

function parseCommitRecord(record: string): CommitMeta | null {
  const f = record.split('\x1f')
  if (f.length < 6) return null
  return {
    hash: f[0],
    shortHash: f[1],
    author: f[2],
    time: Number(f[3]),
    refs: f[4] ? f[4].split(', ').filter(Boolean) : [],
    subject: f[5]
  }
}

export async function gitLog(root: string, limit = 100): Promise<LogResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }

  const res = await runGit(real, ['log', '-n', String(limit), `--format=${LOG_FORMAT}`])
  if (!res.ok) {
    if (NO_COMMITS.test(res.stderr) || NOT_A_REPO.test(res.stderr)) return { ok: true, commits: [] }
    return { ok: false, error: gitErrorOf(res) }
  }
  const commits = res.stdout
    .split('\x1e')
    .map((r) => parseCommitRecord(r.replace(/^\n/, '')))
    .filter((c): c is CommitMeta => c !== null)
  return { ok: true, commits }
}

// ---------- commit detail ----------

export interface CommitFile {
  path: string
  origPath?: string
  status: FileStatus
  additions: number | null
  deletions: number | null
}

export type CommitDetailResult =
  | { ok: true; meta: CommitMeta; authorEmail: string; body: string; files: CommitFile[] }
  | { ok: false; error: string }

const HASH_RE = /^[0-9a-f]{4,40}$/i

export async function gitCommitDetail(root: string, hash: string): Promise<CommitDetailResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }
  if (!HASH_RE.test(hash)) return { ok: false, error: 'invalid commit hash' }

  const show = await runGit(real, [
    'show',
    '-s',
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%D%x1f%s%x1f%b',
    hash
  ])
  if (!show.ok) return { ok: false, error: gitErrorOf(show) }
  const f = show.stdout.split('\x1f')
  if (f.length < 8) return { ok: false, error: 'unexpected git show output' }
  const meta: CommitMeta = {
    hash: f[0],
    shortHash: f[1],
    author: f[2],
    time: Number(f[4]),
    refs: f[5] ? f[5].split(', ').filter(Boolean) : [],
    subject: f[6]
  }

  const treeArgs = ['diff-tree', '-r', '--root', '--no-commit-id', '--find-renames', '-z']
  const [numstat, nameStatus] = await Promise.all([
    runGit(real, [...treeArgs, '--numstat', hash]),
    runGit(real, [...treeArgs, '--name-status', hash])
  ])
  if (!nameStatus.ok) return { ok: false, error: gitErrorOf(nameStatus) }

  const stats = numstat.ok ? parseNumstat(numstat.stdout) : new Map()
  const files: CommitFile[] = []
  const tokens = nameStatus.stdout.split('\0')
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const st = tokens[i]
    if (!st) continue
    const letter = st[0] as FileStatus
    const renamed = letter === 'R' || letter === 'C'
    const origPath = renamed ? tokens[i + 1] : undefined
    const path = renamed ? tokens[(i += 1) + 1] : tokens[i + 1]
    if (path === undefined) break
    const s = stats.get(path)
    files.push({
      path,
      ...(origPath !== undefined && { origPath }),
      status: renamed ? letter : statusLetter('1', `${st[0]}.`),
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null
    })
  }

  return { ok: true, meta, authorEmail: f[3], body: f.slice(7).join('\x1f').trim(), files }
}

// ---------- diffs ----------

export type GitDiffSpec =
  | { kind: 'worktree'; path: string; origPath?: string; untracked: boolean }
  | { kind: 'commit'; hash: string; path: string; origPath?: string }

export type DiffResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string }

/** Diffs beyond this are cut at a line boundary — the renderer shows a notice */
const MAX_DIFF_CHARS = 1_000_000

function capDiff(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARS) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', MAX_DIFF_CHARS)
  return { text: text.slice(0, cut > 0 ? cut : MAX_DIFF_CHARS), truncated: true }
}

export async function gitDiff(root: string, spec: GitDiffSpec): Promise<DiffResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }

  if (spec.kind === 'commit') {
    if (!HASH_RE.test(spec.hash)) return { ok: false, error: 'invalid commit hash' }
    const paths = spec.origPath ? [spec.path, spec.origPath] : [spec.path]
    const res = await runGit(real, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--find-renames',
      '-p',
      '--no-color',
      spec.hash,
      '--',
      ...paths
    ])
    if (!res.ok) return { ok: false, error: gitErrorOf(res) }
    return { ok: true, ...capDiff(res.stdout) }
  }

  if (spec.untracked) {
    // --no-index exits 1 when the files differ — success is "we got a diff"
    const res = await runGit(real, [
      'diff',
      '--no-color',
      '--no-index',
      '--',
      '/dev/null',
      spec.path
    ])
    if (res.stdout.startsWith('diff ')) return { ok: true, ...capDiff(res.stdout) }
    return { ok: false, error: gitErrorOf(res) }
  }

  // Rename pairs need both paths in the pathspec or the pair shows as add+delete
  const paths = spec.origPath ? [spec.path, spec.origPath] : [spec.path]
  let res = await runGit(real, ['diff', '--no-color', '--find-renames', 'HEAD', '--', ...paths])
  // A repo with no commits yet has no HEAD — fall back to index vs worktree
  if (!res.ok && NO_COMMITS.test(res.stderr)) {
    res = await runGit(real, ['diff', '--no-color', '--', ...paths])
  }
  if (!res.ok) return { ok: false, error: gitErrorOf(res) }
  return { ok: true, ...capDiff(res.stdout) }
}

// ---------- watchers ----------
//
// One recursive watcher per subscribed root, feeding a debounced git:changed
// event. Inside .git only the files that signal "repo state moved" are kept —
// HEAD, index, refs — so object-store churn never wakes the renderer.

export interface GitChangedEvent {
  watchId: number
}

/** .git entries worth waking up for; everything else in .git is noise */
const GIT_INTERNAL_KEEP = /^(HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs|index|refs(\/|$))/

interface GitWatchEntry {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

const gitWatches = new Map<number, GitWatchEntry>()
let nextGitWatchId = 1

const GIT_DEBOUNCE_MS = 400

function gitWatchIgnored(path: string): boolean {
  if (path.includes('/node_modules')) return true
  const idx = path.indexOf('/.git')
  if (idx === -1) return false
  const rest = path.slice(idx + '/.git'.length)
  // .git itself must stay traversable or HEAD/refs are never seen
  if (rest === '') return false
  return !GIT_INTERNAL_KEEP.test(rest.slice(1))
}

export function startGitWatch(win: BrowserWindow, root: string): number {
  const real = resolveInsideRoots(root)
  // Never recursively watch the home directory itself — projects only
  if (!real || real === homedir()) return -1

  const id = nextGitWatchId++
  const entry: GitWatchEntry = {
    watcher: chokidar.watch(real, { ignoreInitial: true, ignored: gitWatchIgnored }),
    timer: null
  }
  entry.watcher.on('all', () => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      safeSend(win, 'git:changed', { watchId: id } satisfies GitChangedEvent)
    }, GIT_DEBOUNCE_MS)
  })
  entry.watcher.on('error', (err) => {
    console.error(`git watch ${id}:`, err)
  })
  gitWatches.set(id, entry)
  return id
}

export function stopGitWatch(watchId: number): void {
  const entry = gitWatches.get(watchId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  void entry.watcher.close()
  gitWatches.delete(watchId)
}

export function disposeAllGitWatches(): void {
  for (const id of [...gitWatches.keys()]) stopGitWatch(id)
}
