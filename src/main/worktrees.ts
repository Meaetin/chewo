import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { gitErrorOf as gitError, runGit as git } from './git'
import { defaultRemoteRef } from './git-ops'

/**
 * Git operations for isolated agent worktrees (SPEC §10). Everything runs
 * against the user's real repos, so the rules are strict: never --force,
 * never -D, never stash, always surface git's own message verbatim.
 *
 * Nothing here lands work any more. Merging a branch into the local main
 * checkout was removed once Ship existed: it bypassed review, it never pushed
 * (so local main drifted from origin), and its cleanup was a second mechanism
 * for the job the merged-PR reaper already does.
 */

export const WORKTREES_ROOT = join(homedir(), '.chewo', 'worktrees')

const TASK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

export function validateTaskName(name: string): string | null {
  if (!name.trim()) return 'Task name is required'
  if (name.length > 60) return 'Task name too long (max 60 chars)'
  if (!TASK_NAME_RE.test(name))
    return 'Use letters, digits, dots, dashes or underscores; start with a letter or digit'
  if (name.includes('..') || name.endsWith('.lock'))
    return 'Task name is not a valid git branch name'
  return null
}

export const branchFor = (taskName: string): string => `agent/${taskName}`

export function worktreeDirFor(projectPath: string, taskName: string): string {
  return join(WORKTREES_ROOT, basename(projectPath), taskName)
}

export type ListBranchesResult =
  | {
      ok: true
      /** Branch the main checkout is on — the default base; 'HEAD' when detached */
      current: string
      local: string[]
      /** `origin/feature`, … — basing on one gives the new branch that upstream */
      remote: string[]
    }
  | { ok: false; error: string }

/** Branches offered as the base for a new isolated terminal. */
export async function listBranches(projectPath: string): Promise<ListBranchesResult> {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` }

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const refs = await git(projectPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes'
  ])
  if (!refs.ok) return { ok: false, error: gitError(refs) }

  const local: string[] = []
  const remote: string[] = []
  for (const name of refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    // `origin/HEAD` is a symref alias for the remote's default branch, not a base
    if (name.endsWith('/HEAD')) continue
    if (name.includes('/')) remote.push(name)
    else local.push(name)
  }
  // A remote-only ref can share a local branch's name once fetched; both are
  // still distinct start points, so neither list is filtered against the other.
  return { ok: true, current: head.ok ? head.stdout.trim() : 'HEAD', local, remote }
}

export interface DiscoveredWorktree {
  path: string
  /** Empty when the worktree sits on a detached HEAD — nothing to merge by name */
  branch: string
  taskName: string
  /** Commit the branch was cut at; undefined when its reflog can't say */
  baseCommit?: string
}

/**
 * Where a branch started, read from its own reflog (`branch: Created from X`
 * is its oldest entry). Worktrees we created carry this on their record, but
 * an adopted one has no record — and without a start point there is no way to
 * tell a branch whose work landed from one that was never worked on at all.
 */
async function creationCommit(projectPath: string, branch: string): Promise<string | undefined> {
  if (!branch) return undefined
  const res = await git(projectPath, ['reflog', 'show', '--no-abbrev', '--format=%H', branch])
  if (!res.ok) return undefined
  const entries = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  return entries.at(-1)
}

export type ListWorktreesResult =
  | { ok: true; head: string; worktrees: DiscoveredWorktree[] }
  | { ok: false; error: string }

/**
 * Isolated checkouts git itself knows about. The sidebar lists these rather
 * than only our own records, so a worktree removed with `git worktree remove`
 * outside the app disappears from it, and one whose record we never kept (a
 * different install writes a different projects.json — dev and packaged builds
 * don't share one) is still reachable. Only paths under our root are returned:
 * worktrees the user keeps elsewhere are not the app's business.
 */
export async function listWorktrees(projectPath: string): Promise<ListWorktreesResult> {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` }

  const res = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return { ok: false, error: gitError(res) }

  const ours = join(WORKTREES_ROOT, basename(projectPath)) + '/'
  const found: DiscoveredWorktree[] = []
  let path = ''
  let branch = ''
  // Records are blank-line separated; `worktree <path>` opens each one
  const flush = (): void => {
    if (path.startsWith(ours)) found.push({ path, branch, taskName: basename(path) })
    path = ''
    branch = ''
  }
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()

  for (const w of found) w.baseCommit = await creationCommit(projectPath, w.branch)

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { ok: true, head: head.ok ? head.stdout.trim() : 'HEAD', worktrees: found }
}

export interface WorktreeState {
  /** git can no longer reach the checkout — the folder was deleted or moved */
  missing: boolean
  /** False on a detached HEAD, or when the branch was deleted underneath us */
  branchExists: boolean
  /** Commits the main checkout's branch doesn't have yet */
  ahead: number
  behind: number
  /** Uncommitted files in the checkout */
  dirty: number
  /**
   * The branch did work and all of it is on the main checkout's branch — the
   * worktree is spent. Requires a known start point: "nothing ahead" alone
   * describes a freshly created branch just as well as a merged one, and
   * locking a fresh worktree would be worse than leaving a spent one open.
   * Uncommitted work always keeps it live, whatever the commits say.
   */
  merged: boolean
}

/** Everything the sidebar needs to decide whether a branch is still live work. */
export async function worktreeState(
  projectPath: string,
  worktreePath: string,
  branch: string,
  baseCommit?: string
): Promise<WorktreeState> {
  const missing = !existsSync(worktreePath)
  const dead: WorktreeState = {
    missing,
    branchExists: false,
    ahead: 0,
    behind: 0,
    dirty: 0,
    merged: false
  }
  if (!branch) return dead

  const tip = await git(projectPath, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])
  if (!tip.ok) return dead

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const target = head.ok ? head.stdout.trim() : 'HEAD'
  const counts = await git(projectPath, [
    'rev-list',
    '--left-right',
    '--count',
    `${target}...${branch}`
  ])
  const [behindRaw, aheadRaw] = counts.ok ? counts.stdout.trim().split(/\s+/) : []
  const ahead = Number(aheadRaw) || 0
  const behind = Number(behindRaw) || 0

  const status = missing ? null : await git(worktreePath, ['status', '--porcelain'])
  const dirty = status?.ok ? status.stdout.split('\n').filter((l) => l.trim()).length : 0

  const start = baseCommit ?? (await creationCommit(projectPath, branch))
  return {
    missing,
    branchExists: true,
    ahead,
    behind,
    dirty,
    merged: ahead === 0 && dirty === 0 && !!start && start !== tip.stdout.trim()
  }
}

/** A base ref reaches git as an argv element — anything flag-shaped is refused. */
export function validateBaseRef(base: string): string | null {
  if (!base.trim()) return 'Base branch is required'
  if (base.startsWith('-')) return 'Base branch is not a valid git ref'
  return null
}

export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string; baseBranch: string; baseCommit: string }
  | { ok: false; error: string }

/**
 * `origin/main`, unless local `main` holds commits it doesn't — then local.
 *
 * Fetching and cutting from the remote is what makes a session start current
 * without the main checkout being touched. But the merge modal lands a branch
 * into local `main` and **never pushes**, so a repo where you merge locally
 * has a `main` that origin has never seen; always cutting from origin would
 * quietly hand every later session a checkout missing that work. Whichever ref
 * is ahead wins, which is right in both directions and needs no setting.
 */
async function freshestBase(projectPath: string, remoteRef: string): Promise<string> {
  const local = remoteRef.slice(remoteRef.indexOf('/') + 1)
  const exists = await git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${local}`])
  if (!exists.ok) return remoteRef
  const ahead = await git(projectPath, ['rev-list', '--count', `${remoteRef}..${local}`])
  return ahead.ok && Number(ahead.stdout.trim()) > 0 ? local : remoteRef
}

/**
 * `base` is the start point for the new branch — any branch in the repo,
 * including a remote-tracking one.
 *
 * Omitting it means **`origin`'s default branch, freshly fetched**, not the
 * main checkout's HEAD. Since a session is a worktree, this is the moment that
 * decides whether it starts on current code, and doing it here rather than by
 * pulling means the main checkout is never touched — no ref moves under the
 * agents already working in it. The fetch is best effort: offline, or a repo
 * with no remote, falls back to local HEAD exactly as this used to behave.
 */
export async function createWorktree(
  projectPath: string,
  taskName: string,
  base?: string
): Promise<CreateWorktreeResult> {
  const invalid = validateTaskName(taskName)
  if (invalid) return { ok: false, error: invalid }

  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` }

  const dir = worktreeDirFor(projectPath, taskName)
  if (existsSync(dir)) return { ok: false, error: `Worktree folder already exists: ${dir}` }

  let baseBranch: string
  let baseCommit: string
  if (base === undefined) {
    await git(projectPath, ['fetch', 'origin', '--prune'], 120_000)
    const remote = await defaultRemoteRef(projectPath)
    const start = remote ? await freshestBase(projectPath, remote) : null
    const rev = start
      ? await git(projectPath, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`])
      : { ok: false, stdout: '', stderr: '' }
    if (start && rev.ok) {
      baseBranch = start
      baseCommit = rev.stdout.trim()
    } else {
      const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      baseBranch = head.ok ? head.stdout.trim() : 'HEAD'
      const local = await git(projectPath, ['rev-parse', 'HEAD'])
      baseCommit = local.ok ? local.stdout.trim() : ''
    }
  } else {
    const badBase = validateBaseRef(base)
    if (badBase) return { ok: false, error: badBase }
    // Resolve before the expensive checkout so a typo fails in milliseconds
    const rev = await git(projectPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    if (!rev.ok) return { ok: false, error: `Base branch not found: ${base}` }
    baseBranch = base
    baseCommit = rev.stdout.trim()
  }

  const branch = branchFor(taskName)

  // Full checkout of the tree — can take a few seconds on large repos.
  // `--no-track` because basing on `origin/<default>` otherwise has git point
  // the task branch's upstream at `refs/heads/main`: `git status` then reports
  // it against a branch it is not, and Ship's `git push` refuses outright
  // ("the upstream branch … does not match the name of your current branch").
  // Ship sets the real upstream when it first pushes.
  const res = await git(
    projectPath,
    ['worktree', 'add', '--no-track', '-b', branch, dir, baseBranch],
    300_000
  )
  if (!res.ok) return { ok: false, error: gitError(res) }
  return { ok: true, path: dir, branch, baseBranch, baseCommit }
}

/**
 * A worktree checks out tracked files only, so a fresh one has no
 * `node_modules` and nothing in it runs — the agent can read and edit
 * immediately, but its first `npm test` fails for a reason that has nothing to
 * do with the code.
 *
 * `cp -c` is an APFS clone: copy-on-write, so a 667 MB `node_modules` costs
 * **0 MB** of real disk and ~8 s of wall clock (it is syscall-bound on ~30k
 * files, not bytes — measured on this repo). That is why this is fire and
 * forget: the caller returns as soon as the checkout exists, and the copy
 * lands while the user is still typing.
 *
 * `-p` is load-bearing beyond timestamps: it preserves the **exec bit**, which
 * is what npm strips from node-pty's `spawn-helper` and what the root
 * `postinstall` exists to repair. Cloning sidesteps that entirely.
 *
 * Non-fatal by definition. A project with no `node_modules`, a non-APFS
 * volume, or a destination that somehow exists all just mean the agent runs
 * `npm install` like it would have anyway.
 */
export function cloneNodeModules(
  projectPath: string,
  worktreePath: string
): Promise<string | null> {
  const source = join(projectPath, 'node_modules')
  const dest = join(worktreePath, 'node_modules')
  if (!existsSync(source) || existsSync(dest)) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/bin/cp', ['-cRp', source, dest], { timeout: 300_000 }, (err, _out, stderr) => {
      if (!err) return resolve(null)
      resolve(String(stderr).trim().split('\n')[0] || err.message)
    })
  })
}

export type RemoveWorktreeResult =
  | { ok: true; branchDeleted: boolean; note?: string }
  | { ok: false; error: string }

/**
 * Remove the worktree and delete its branch. git refuses on modified or
 * untracked files (our uncommitted-work safety net) and `-d` refuses on
 * unmerged branches — both are surfaced, never forced.
 *
 * `discard` is the one exception, and it only ever arrives from a person who
 * was told in a dialog exactly what is about to be lost: abandoning a branch
 * you don't want to finish *means* throwing away uncommitted files and
 * unmerged commits, so a refusal there is the wrong answer rather than a
 * safety net. Everything automatic (the merged-PR reaper, cleanup after a
 * ship) leaves it off, which keeps "git refuses" as the guard where nobody is
 * watching.
 */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string,
  discard = false
): Promise<RemoveWorktreeResult> {
  const rm = await git(
    projectPath,
    discard
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath],
    120_000
  )
  if (!rm.ok) {
    // A folder that is already gone can't be "removed" — git only lists the
    // checkout until it's pruned. Anything else is a real refusal to surface.
    if (existsSync(worktreePath)) return { ok: false, error: gitError(rm) }
    const pruned = await git(projectPath, ['worktree', 'prune'])
    if (!pruned.ok) return { ok: false, error: gitError(pruned) }
  }

  if (!branch) return { ok: true, branchDeleted: false }
  const br = await git(projectPath, ['branch', discard ? '-D' : '-d', branch])
  return br.ok
    ? { ok: true, branchDeleted: true }
    : { ok: true, branchDeleted: false, note: `Worktree removed; branch kept: ${gitError(br)}` }
}
