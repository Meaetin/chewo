import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
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
  /**
   * A wholly-untracked directory, which git collapses into a single status
   * entry with a trailing slash. It has no diff of its own — the files inside
   * it are listed on demand via `gitUntrackedFiles`.
   */
  isDir?: boolean
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
      /**
       * Commits the checkout is missing. Measured against `upstream` when the
       * branch has one, and against `baseRef` when it does not — which is
       * every session's branch, since a worktree is cut `--no-track`.
       */
      behind: number
      /**
       * What `behind` was measured against when there is no upstream: the
       * `origin/<default>` ref Update would merge. Null when the branch tracks
       * something of its own, or when the repo can't name a default.
       */
      baseRef: string | null
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

/**
 * The remote's default branch as a remote-tracking ref (`origin/main`), read
 * from the local symref that `git clone` writes — **no network**, which is
 * what makes it usable on the path that cuts every new worktree, and safe to
 * run on every status poll.
 *
 * `origin/HEAD` is missing on repos created with `git init` and a hand-added
 * remote, so the common names are tried after it. Null means "this repo can't
 * tell us", and every caller treats that as a reason to fall back rather than
 * to fail.
 */
export async function defaultRemoteRef(cwd: string): Promise<string | null> {
  const symref = await runGit(cwd, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'])
  if (symref.ok && symref.stdout.trim()) return symref.stdout.trim()
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    const exists = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`])
    if (exists.ok) return `origin/${name}`
  }
  return null
}

/** A checkout parked on work that has already been sent out, and where it should go back to. */
export interface StaleCheckout {
  /** The branch the checkout is standing on */
  branch: string
  /** The local branch to return to — `main`, not `origin/main` */
  target: string
  /** Whether the branch has landed on the default, or is only pushed and awaiting review */
  reason: 'merged' | 'pushed'
}

/**
 * Whether a checkout is sitting on a branch whose work has all left the
 * building — every commit on it is reachable from some remote-tracking ref.
 *
 * This is the state Ship leaves the shared checkout in, and it is invisible
 * from inside: the branch looks like ordinary work, so every session that opts
 * out of isolation quietly starts on top of it. A branch switched by hand — or
 * by an agent in a terminal — reaches the same place, so the check is on the
 * state rather than on how it was reached.
 *
 * **The test is "all pushed", not "merged", and that distinction is the whole
 * point.** Ship pushes and opens a PR, and a PR is unmerged for as long as
 * review takes, so gating on `merge-base --is-ancestor` meant the checkout Ship
 * parked on a branch stayed parked on it until somebody hit Merge and a fetch
 * caught up — which is days after the moment a person actually wants their
 * checkout back. `rev-list HEAD --not --remotes` covers all three ways work
 * leaves in one reading: the PR route (the commits are on `origin/<branch>`),
 * the direct push route (they are on `origin/<base>`), and a branch whose PR
 * has since landed. Zero unsent commits plus a clean tree means switching away
 * cannot cost anything — the branch itself stays right where it is.
 *
 * Entirely local — the remote-tracking refs are the ones we already have, so no
 * network, which is what makes it safe on every project selection. It is also
 * why this no longer depends on `origin/<default>` being fresh: a just-pushed
 * branch is recognised from its own remote-tracking ref. **Squash and rebase
 * merges are still invisible**, for the same reason they are to `worktreeState`
 * — they rewrite SHAs, so the local commits are on no remote ref and this
 * reports nothing rather than guessing.
 */
export async function staleCheckout(root: string): Promise<StaleCheckout | null> {
  const cwd = resolveInsideRoots(root)
  if (!cwd) return null

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return null
  const branch = head.stdout.trim()
  if (!branch || branch === 'HEAD') return null

  const remoteRef = await defaultRemoteRef(cwd)
  if (!remoteRef) return null
  const target = remoteRef.slice(remoteRef.indexOf('/') + 1)
  if (branch === target) return null

  // Uncommitted work is a reason to stay put: switching would carry it onto
  // the default branch, which is not something to offer in a one-click row
  const dirty = await runGit(cwd, ['status', '--porcelain', '-uno'])
  if (!dirty.ok || dirty.stdout.trim()) return null

  // Anything here that no remote has seen is unsent work, and unsent work is a
  // reason to stay: the branch is still the only copy of it
  const unsent = await runGit(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  if (!unsent.ok || unsent.stdout.trim() !== '0') return null

  // Only the wording depends on this, so a failure reads as the weaker claim
  const merged = await runGit(cwd, ['merge-base', '--is-ancestor', branch, remoteRef])
  return { branch, target, reason: merged.ok ? 'merged' : 'pushed' }
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
  let baseRef: string | null = null
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
      const path = t.slice(2)
      files.push({
        path,
        status: '?',
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        ...(path.endsWith('/') && { isDir: true })
      })
    }
  }

  if (detached && headOid) branch = headOid.slice(0, 7)

  /**
   * A task branch is cut `--no-track`, so git emits no `# branch.ab` for it and
   * `behind` would read 0 forever — on precisely the branches whose base moves
   * under them while an agent works. Count against the ref Update actually
   * merges instead. Local-only (the remote-tracking ref is whatever the last
   * fetch left), which is what keeps this safe to run on every status poll.
   */
  if (!upstream && headOid && !detached) {
    const base = await defaultRemoteRef(real)
    if (base) {
      const count = await runGit(real, ['rev-list', '--count', `HEAD..${base}`])
      // A failure here is a repo that can't answer (no such ref yet), not a
      // level checkout — leaving `behind` at 0 hides Update, which is the safe
      // direction: it never claims work is waiting that isn't.
      if (count.ok) behind = Number(count.stdout.trim()) || 0
      baseRef = base
    }
  }

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

  return { ok: true, isRepo: true, branch, detached, upstream, ahead, behind, baseRef, headOid, files }
}

// ---------- untracked directories ----------

export type UntrackedFilesResult =
  | { ok: true; paths: string[]; total: number }
  | { ok: false; error: string }

/** A collapsed directory can hold thousands of files — the panel lists a page */
const MAX_UNTRACKED_LISTED = 500

/**
 * Repo-relative, no traversal, no pathspec magic (`:(glob)`, `:!`), and not
 * flag-shaped. Exported because `git-discard.ts` hands the same strings to
 * commands that delete files, where the bar is higher than for a read.
 */
export const safePathspec = (p: string): boolean =>
  p !== '' &&
  !p.startsWith('/') &&
  !p.startsWith(':') &&
  !p.startsWith('-') &&
  !p.split('/').includes('..')

/**
 * The files inside an untracked directory. `git status` collapses such a
 * directory into one entry rather than listing every file, so the panel
 * expands it on demand instead of running status with `-uall` — that would
 * flood the list with build output the moment one output dir goes unignored.
 */
export async function gitUntrackedFiles(root: string, dir: string): Promise<UntrackedFilesResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }
  if (!safePathspec(dir)) return { ok: false, error: 'invalid path' }

  const res = await runGit(real, ['ls-files', '--others', '--exclude-standard', '-z', '--', dir])
  if (!res.ok) return { ok: false, error: gitErrorOf(res) }
  const paths = res.stdout.split('\0').filter(Boolean)
  return { ok: true, paths: paths.slice(0, MAX_UNTRACKED_LISTED), total: paths.length }
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
    // A collapsed untracked directory has no diff: --no-index given a file and
    // a directory resolves the file's basename *inside* the directory, so this
    // would ask git for `<dir>/null` and fail. Expand it in the panel instead.
    if (spec.path.endsWith('/')) return { ok: false, error: 'New folder — open a file inside it' }
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
//
// This uses node's recursive fs.watch (FSEvents on macOS) rather than chokidar.
// Chokidar 5 has no fsevents path: it opens one fs.watch per directory, which
// measured 2433 file descriptors for this repo alone — 1125 of its 1137 watched
// directories were gitignored build output (dist/, .build/). Enough subscribed
// roots and the process hits EMFILE and every watcher starts failing. FSEvents
// costs no descriptors and no startup traversal, and the filtering below was
// already ours to do.

export interface GitChangedEvent {
  watchId: number
}

/** .git entries worth waking up for; everything else in .git is noise */
const GIT_INTERNAL_KEEP = /^(HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs|index|refs(\/|$))/

interface GitWatchEntry {
  watcher: FSWatcher
  /** Drops a debounce still in flight, so a closed watcher can't fire late */
  cancelPending: () => void
}

const gitWatches = new Map<number, GitWatchEntry>()
let nextGitWatchId = 1

const GIT_DEBOUNCE_MS = 400

/** Exported for tests — the only logic between an FSEvent and a renderer wake. */
export function gitWatchIgnored(path: string): boolean {
  if (path.includes('/node_modules/') || path.endsWith('/node_modules')) return true
  // Match the directory, not the prefix — /.gitignore is a tracked file whose
  // edits move `git status`, so it must not be swallowed as a .git internal
  const idx = path.indexOf('/.git/')
  if (idx === -1) return false
  return !GIT_INTERNAL_KEEP.test(path.slice(idx + '/.git/'.length))
}

export function startGitWatch(win: BrowserWindow, root: string): number {
  const real = resolveInsideRoots(root)
  // Never recursively watch the home directory itself — projects only
  if (!real || real === homedir()) return -1

  const id = nextGitWatchId++
  let timer: NodeJS.Timeout | null = null

  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      safeSend(win, 'git:changed', { watchId: id } satisfies GitChangedEvent)
    }, GIT_DEBOUNCE_MS)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(real, { recursive: true }, (_event, filename) => {
      // FSEvents coalesces, and drops the name when it does — assume it mattered
      if (filename === null || !gitWatchIgnored(join(real, filename.toString()))) fire()
    })
  } catch (err) {
    console.error(`git watch ${id}:`, err)
    return -1
  }
  watcher.on('error', (err) => {
    console.error(`git watch ${id}:`, err)
  })

  gitWatches.set(id, {
    watcher,
    cancelPending: () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  })
  return id
}

export function stopGitWatch(watchId: number): void {
  const entry = gitWatches.get(watchId)
  if (!entry) return
  entry.cancelPending()
  entry.watcher.close()
  gitWatches.delete(watchId)
}

export function disposeAllGitWatches(): void {
  for (const id of [...gitWatches.keys()]) stopGitWatch(id)
}
