import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { gitErrorOf as gitError, runGit as git } from './git'

/**
 * Git operations for isolated agent worktrees (SPEC §10). Everything runs
 * against the user's real repos, so the rules are strict: never --force,
 * never -D, never stash, always surface git's own message verbatim. A
 * conflicted merge is aborted so the main checkout is never left mid-merge.
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
 * `base` is the start point for the new branch — any branch in the repo,
 * including a remote-tracking one. Omitted means the main checkout's HEAD,
 * which is what the app did before the base was selectable.
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
    const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    baseBranch = head.ok ? head.stdout.trim() : 'HEAD'
    const rev = await git(projectPath, ['rev-parse', 'HEAD'])
    baseCommit = rev.ok ? rev.stdout.trim() : ''
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

  // Full checkout of the tree — can take a few seconds on large repos
  const res = await git(projectPath, ['worktree', 'add', '-b', branch, dir, baseBranch], 300_000)
  if (!res.ok) return { ok: false, error: gitError(res) }
  return { ok: true, path: dir, branch, baseBranch, baseCommit }
}

/**
 * Local branch a base ref is meant to land on. A worktree based on
 * `origin/main` lands on `main` — comparing the stored base to the checkout's
 * HEAD by name alone would flag every remote-based worktree as drifted, and a
 * warning that fires on every merge is a warning nobody reads.
 */
export function landingBranchFor(base: string, remotes: string[]): string {
  const slash = base.indexOf('/')
  if (slash === -1) return base
  return remotes.includes(base.slice(0, slash)) ? base.slice(slash + 1) : base
}

export type WorktreeStatusResult =
  | {
      ok: true
      /** Uncommitted changes in the worktree — merge is blocked until the agent commits */
      dirty: boolean
      /** Branch the main checkout is currently on — the merge target */
      targetBranch: string
      /** The main checkout is on no branch at all; a merge there would be stranded */
      detached: boolean
      /** Branch this worktree was meant to land on (`origin/main` → `main`) */
      landingBranch: string
      /** False when someone moved the main checkout off the landing branch */
      targetIsLanding: boolean
      /** `git log --oneline target..branch` */
      commits: string[]
      /** `git diff --stat target...branch` */
      diffStat: string
    }
  | { ok: false; error: string }

export async function worktreeStatus(
  projectPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<WorktreeStatusResult> {
  const status = await git(worktreePath, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, error: gitError(status) }

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { ok: false, error: gitError(head) }
  const targetBranch = head.stdout.trim()
  const detached = targetBranch === 'HEAD'

  const remotes = await git(projectPath, ['remote'])
  const landingBranch = landingBranchFor(
    baseBranch,
    remotes.ok ? remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  )

  const log = await git(projectPath, ['log', '--oneline', `${targetBranch}..${branch}`])
  const diff = await git(projectPath, ['diff', '--stat', `${targetBranch}...${branch}`])
  return {
    ok: true,
    dirty: status.stdout.trim().length > 0,
    targetBranch,
    detached,
    landingBranch,
    targetIsLanding: !detached && targetBranch === landingBranch,
    commits: log.ok ? log.stdout.split('\n').filter(Boolean) : [],
    diffStat: diff.ok ? diff.stdout.trimEnd() : ''
  }
}

export type MergeWorktreeResult = { ok: true } | { ok: false; error: string; aborted: boolean }

/**
 * Merge the task branch into the MAIN checkout. Conflicts abort.
 *
 * `expectedTarget` is the branch the user was shown when they opened the merge
 * modal. Several agents share that one checkout, so any of them can `git
 * checkout -b` between the modal opening and the button click — without this
 * check the merge would silently land on whatever branch they moved it to.
 * HEAD is re-read here rather than trusted from the renderer.
 */
export async function mergeWorktree(
  projectPath: string,
  branch: string,
  expectedTarget: string
): Promise<MergeWorktreeResult> {
  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { ok: false, error: gitError(head), aborted: false }
  const target = head.stdout.trim()
  if (target === 'HEAD')
    return {
      ok: false,
      error: 'The main checkout is on no branch (detached HEAD) — a merge there would be lost.',
      aborted: false
    }
  if (target !== expectedTarget)
    return {
      ok: false,
      error: `The main checkout moved to ${target} since you opened this (it was ${expectedTarget}). Nothing was merged — refresh and check the target.`,
      aborted: false
    }

  const res = await git(projectPath, ['merge', '--no-ff', '--no-edit', branch], 120_000)
  if (res.ok) return { ok: true }

  // Conflict leaves MERGE_HEAD behind — abort so main is never left mid-merge
  const midMerge = await git(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (midMerge.ok) await git(projectPath, ['merge', '--abort'])
  return { ok: false, error: gitError(res), aborted: midMerge.ok }
}

export type RemoveWorktreeResult =
  | { ok: true; branchDeleted: boolean; note?: string }
  | { ok: false; error: string }

/**
 * Remove the worktree and delete its branch. git refuses on modified or
 * untracked files (our uncommitted-work safety net) and `-d` refuses on
 * unmerged branches — both are surfaced, never forced.
 */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string
): Promise<RemoveWorktreeResult> {
  const rm = await git(projectPath, ['worktree', 'remove', worktreePath], 120_000)
  if (!rm.ok) {
    // A folder that is already gone can't be "removed" — git only lists the
    // checkout until it's pruned. Anything else is a real refusal to surface.
    if (existsSync(worktreePath)) return { ok: false, error: gitError(rm) }
    const pruned = await git(projectPath, ['worktree', 'prune'])
    if (!pruned.ok) return { ok: false, error: gitError(pruned) }
  }

  if (!branch) return { ok: true, branchDeleted: false }
  const br = await git(projectPath, ['branch', '-d', branch])
  return br.ok
    ? { ok: true, branchDeleted: true }
    : { ok: true, branchDeleted: false, note: `Worktree removed; branch kept: ${gitError(br)}` }
}
