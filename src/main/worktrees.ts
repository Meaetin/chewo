import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { matchesLocalFile } from '../shared/local-files'
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
 * The remote a base ref belongs to, or null when it names a local branch.
 * Asked of git rather than pattern-matched on `origin/`: a remote can be
 * called anything, and a local branch is perfectly allowed to have a slash in
 * its name (`feature/login` is not a remote called `feature`).
 */
async function remoteOf(projectPath: string, ref: string): Promise<string | null> {
  const slash = ref.indexOf('/')
  if (slash <= 0) return null
  const exists = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`])
  return exists.ok ? ref.slice(0, slash) : null
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
 *
 * A **named** base is fetched on the same terms when it is a remote-tracking
 * ref, and for the same reason: `origin/feature` on disk is a cache of a
 * branch somebody else moves, so cutting from it unfetched means "as of
 * whenever this repo last heard" — the exact staleness starting current is
 * supposed to rule out. A local branch is skipped: its ref is the truth
 * already, and there is nothing to be behind.
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
    // Best effort, exactly like the default path's: a failure here leaves the
    // cached ref in place and the session still starts, one fetch behind
    const remote = await remoteOf(projectPath, base)
    if (remote) await git(projectPath, ['fetch', remote, '--prune'], 120_000)
    // Resolve *after* the fetch — the point of it is that the tip moved — but
    // before the expensive checkout, so a typo still fails in milliseconds
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
 * Being fire and forget is what makes the copy **atomic** rather than
 * incremental. For those 8 seconds the pane is already open, so anything the
 * session runs — a `npm install` in the setup command, the agent reaching for
 * one itself — would otherwise be writing into a `node_modules` that `cp` is
 * still filling in, and two writers on one tree is a corrupt install nobody
 * can explain afterwards. So the clone lands in a **sibling of the worktree**
 * (same volume, so the rename is atomic; outside the checkout, so `git status`
 * and Ship never see a half-copied folder) and is renamed into place at the
 * end. Whoever finishes first wins and the loser is discarded — the race is
 * still a race, but its window is the microseconds between the check and the
 * rename rather than the whole copy.
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
  const staged = join(dirname(worktreePath), `.${basename(worktreePath)}.node_modules.staged`)
  rmSync(staged, { recursive: true, force: true })
  return new Promise((resolve) => {
    execFile('/bin/cp', ['-cRp', source, staged], { timeout: 300_000 }, (err, _out, stderr) => {
      if (!err) {
        try {
          // Something already installed while we copied — its tree is the live
          // one the session has been using, so ours is the one to throw away
          if (existsSync(dest)) rmSync(staged, { recursive: true, force: true })
          else renameSync(staged, dest)
          return resolve(null)
        } catch (e) {
          rmSync(staged, { recursive: true, force: true })
          return resolve(e instanceof Error ? e.message : String(e))
        }
      }
      rmSync(staged, { recursive: true, force: true })
      resolve(String(stderr).trim().split('\n')[0] || err.message)
    })
  })
}

export interface CopyLocalFilesResult {
  /** Repo-relative paths that landed in the worktree */
  copied: string[]
  /** Non-fatal by definition — the checkout is fine, a file didn't make it */
  error?: string
}

/** An insane pattern (`*`) must not turn a session start into a disk copy. */
const MAX_LOCAL_FILES = 100

/**
 * Carry the project's machine-local files — `.env` and whatever else the user
 * named — into a fresh worktree. See `shared/local-files.ts` for why the
 * checkout arrives without them and how the patterns read.
 *
 * Candidates are the main checkout's **ignored** files, read from git rather
 * than from a directory walk, so git's own rules decide what counts as
 * machine-local and this never has to learn where a project hides its build
 * output. `--directory` collapses a wholly-ignored folder into a single entry,
 * which is the difference between one row for `node_modules` and thirty
 * thousand.
 *
 * Ignored is the whole safety argument, and why SPEC §10.4 rejected this
 * before: a file git ignores in the main checkout is ignored in the worktree
 * too (`.gitignore` is tracked, so it comes with the checkout), which means
 * Ship's `git add -A` cannot stage a secret this put there. A file git does
 * *not* ignore is deliberately not a candidate however the patterns are
 * written — copying one would hand Ship an untracked file to commit that the
 * agent never wrote.
 *
 * Unlike `cloneNodeModules` this is **awaited** before the pane opens. It is a
 * handful of small files, and an agent that starts against a missing `.env`
 * reads a broken config once and then reasons from it for the rest of the
 * session. Failure is still non-fatal: the setup command and `cp` by hand both
 * still work, exactly as they did before this existed.
 */
export async function copyLocalFiles(
  projectPath: string,
  worktreePath: string,
  patterns: string[]
): Promise<CopyLocalFilesResult> {
  const listed = await git(projectPath, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory'
  ])
  if (!listed.ok) return { copied: [], error: gitError(listed) }
  const entries = listed.stdout.split('\0').filter(Boolean)

  const copied: string[] = []
  let error: string | undefined
  for (const entry of entries) {
    if (copied.length >= MAX_LOCAL_FILES) {
      error = `stopped after ${MAX_LOCAL_FILES} files — narrow the copy patterns`
      break
    }
    // `node_modules` is `cloneNodeModules`' job (an APFS clone, not a byte
    // copy) and `.git` is shared with the main checkout — never either here,
    // however broad the pattern.
    const top = entry.split('/')[0]
    if (top === 'node_modules' || top === '.git') continue
    if (!matchesLocalFile(entry, patterns)) continue

    const dest = join(worktreePath, entry.replace(/\/$/, ''))
    // Something tracked already occupies the path — the checkout wins
    if (existsSync(dest)) continue
    try {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(join(projectPath, entry), dest, { recursive: true, preserveTimestamps: true })
      copied.push(entry)
    } catch (err) {
      error ??= `${entry}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { copied, error }
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

/**
 * Delete merged local branches that have no checkout left — the other half of
 * the reaper.
 *
 * `reapMerged` is worktree-*record*-driven: it walks the `Worktree`s we know
 * about and removes the ones whose PR landed. A branch outlives its record,
 * so that misses two whole classes. The records drift by design (dev and
 * packaged builds keep separate `projects.json` files, and closing a pane
 * deletes the `SavedTerminal` that was the branch's only handle), and a
 * branch made in a terminal or before the worktree flow never had a record at
 * all. Both are invisible to the reaper and pile up forever.
 *
 * Nothing here trusts the caller's list. A branch checked out in *any*
 * worktree is skipped, so a live agent's branch can never be pulled out from
 * under it; so are HEAD and the repo's default branch. The delete is `-d`,
 * never `-D` — the same house rule as everywhere else in this file, and the
 * reason it is safe to run unattended: git refuses anything it can't see as
 * merged. A squash- or rebase-merged branch is exactly that case (the merge
 * rewrote its SHAs), so it survives this and is left for a person to remove
 * from the sidebar, which is the same blind spot `worktreeState` has.
 *
 * Returns the names actually deleted — a refusal is not an error here, it is
 * the guard doing its job, so it is dropped rather than surfaced.
 */
export async function pruneMergedBranches(
  projectPath: string,
  merged: string[]
): Promise<string[]> {
  if (!merged.length) return []

  const held = await heldBranches(projectPath)
  // A checkout list we couldn't read is not "nothing is checked out" — without
  // it there is no way to know a branch is free, so nothing is touched
  if (!held) return []

  const refs = await git(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!refs.ok) return []
  const local = new Set(refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean))

  const deleted: string[] = []
  for (const branch of new Set(merged)) {
    if (!local.has(branch) || held.has(branch)) continue
    if ((await git(projectPath, ['branch', '-d', branch])).ok) deleted.push(branch)
  }
  return deleted
}

/**
 * Branches no sweep may touch: checked out in any worktree (so a live agent's
 * branch can never go), whatever HEAD is on, and the repo's own default.
 *
 * `null` means the checkout list could not be read, which callers must treat
 * as "delete nothing" rather than as an empty set.
 */
async function heldBranches(projectPath: string): Promise<Set<string> | null> {
  const wt = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!wt.ok) return null
  const held = new Set(
    wt.stdout
      .split('\n')
      .filter((l) => l.startsWith('branch '))
      .map((l) => l.slice('branch '.length).trim().replace(/^refs\/heads\//, ''))
  )
  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.ok) held.add(head.stdout.trim())

  // `origin/main` names the branch we must never delete locally; a remote name
  // can't contain a slash, so the first segment is the remote
  const base = await defaultRemoteRef(projectPath)
  if (base) held.add(base.replace(/^[^/]+\//, ''))
  return held
}

/**
 * Branches this project could conceivably lose, read **without any network**.
 *
 * This exists to keep the sweep off the network. `reapMerged` asks every
 * project, not just the ones holding worktree records — that is the whole
 * point, since a project whose records drifted away is exactly the one with
 * orphans — but a `gh pr list` per project per window focus is a real tax on
 * a sidebar with a dozen repos, most of which have nothing to clean and are
 * not even open. An empty answer here means the project is skipped before any
 * round-trip is spent.
 *
 * `--merged <origin/default>` is the filter because it is close to the test
 * `git branch -d` will apply anyway, so this rules out the common cases for
 * free: a repo holding only its default branch, and one whose extra branches
 * are all live work. It is a *necessary* condition, not a sufficient one —
 * the delete still goes through `-d`, and a stale `origin/<default>` (an
 * unvisited project has not been fetched) simply under-reports, which leaves
 * branches for the next pass instead of deleting anything it shouldn't.
 */
export async function pruneCandidates(projectPath: string): Promise<string[]> {
  const base = await defaultRemoteRef(projectPath)
  // No remote default is no notion of "landed", so there is nothing to sweep
  if (!base) return []
  const held = await heldBranches(projectPath)
  if (!held) return []

  const refs = await git(projectPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--merged',
    base,
    'refs/heads'
  ])
  if (!refs.ok) return []
  return refs.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => b && !held.has(b))
}
