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

export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string; baseBranch: string }
  | { ok: false; error: string }

export async function createWorktree(
  projectPath: string,
  taskName: string
): Promise<CreateWorktreeResult> {
  const invalid = validateTaskName(taskName)
  if (invalid) return { ok: false, error: invalid }

  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` }

  const dir = worktreeDirFor(projectPath, taskName)
  if (existsSync(dir)) return { ok: false, error: `Worktree folder already exists: ${dir}` }

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const baseBranch = head.ok ? head.stdout.trim() : 'HEAD'
  const branch = branchFor(taskName)

  // Full checkout of the tree — can take a few seconds on large repos
  const res = await git(projectPath, ['worktree', 'add', '-b', branch, dir, 'HEAD'], 300_000)
  if (!res.ok) return { ok: false, error: gitError(res) }
  return { ok: true, path: dir, branch, baseBranch }
}

export type WorktreeStatusResult =
  | {
      ok: true
      /** Uncommitted changes in the worktree — merge is blocked until the agent commits */
      dirty: boolean
      /** Branch the main checkout is currently on — the merge target */
      targetBranch: string
      /** `git log --oneline target..branch` */
      commits: string[]
      /** `git diff --stat target...branch` */
      diffStat: string
    }
  | { ok: false; error: string }

export async function worktreeStatus(
  projectPath: string,
  worktreePath: string,
  branch: string
): Promise<WorktreeStatusResult> {
  const status = await git(worktreePath, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, error: gitError(status) }

  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { ok: false, error: gitError(head) }
  const targetBranch = head.stdout.trim()

  const log = await git(projectPath, ['log', '--oneline', `${targetBranch}..${branch}`])
  const diff = await git(projectPath, ['diff', '--stat', `${targetBranch}...${branch}`])
  return {
    ok: true,
    dirty: status.stdout.trim().length > 0,
    targetBranch,
    commits: log.ok ? log.stdout.split('\n').filter(Boolean) : [],
    diffStat: diff.ok ? diff.stdout.trimEnd() : ''
  }
}

export type MergeWorktreeResult = { ok: true } | { ok: false; error: string; aborted: boolean }

/** Merge the task branch into whatever the MAIN checkout is on. Conflicts abort. */
export async function mergeWorktree(
  projectPath: string,
  branch: string
): Promise<MergeWorktreeResult> {
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
  if (!rm.ok) return { ok: false, error: gitError(rm) }

  const br = await git(projectPath, ['branch', '-d', branch])
  return br.ok
    ? { ok: true, branchDeleted: true }
    : { ok: true, branchDeleted: false, note: `Worktree removed; branch kept: ${gitError(br)}` }
}
