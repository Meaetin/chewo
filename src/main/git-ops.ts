import { basename } from 'node:path'
import { resolveInsideRoots } from './file-explorer'
import { gitErrorOf, runGit } from './git'

/**
 * The one mutation that isn't shipping: bringing the base branch's new commits
 * into a checkout. Kept out of `git.ts`, which is read-only by contract, and
 * out of `git-ship.ts`, which only ever moves work outward.
 *
 * This used to be a whole branch menu — list, switch, create, fetch, pull,
 * push. All of it went when sessions became worktrees: you don't switch
 * branches in a session's checkout, you start another session; push is Ship's
 * job; and fetch is folded into the one operation left. What survives is the
 * question a running session can still need answered — *main has moved, give
 * me those commits* — which is deliberately **not** `git pull`: a task branch
 * has no upstream, so pull there fails with "no upstream configured" rather
 * than doing anything useful.
 *
 * Same house rules as `worktrees.ts`: never --force, never -D, never stash,
 * and pass git's own message through verbatim. A merge that conflicts is
 * aborted, so a checkout an agent is working in is never left mid-merge.
 */

export type GitOpResult = { ok: true; message: string } | { ok: false; error: string }

/** Network calls are slow but must not hang forever */
const NETWORK_TIMEOUT_MS = 120_000

/**
 * Success lands in a one-line toast, so it gets git's last meaningful line —
 * the ref update, the diffstat, "Already up to date" — rather than the whole
 * transcript, which would collapse into a run-on sentence.
 */
const okWith = (r: { stdout: string; stderr: string }, fallback: string): GitOpResult => {
  // git puts progress and ref updates on stderr, results on stdout
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean)
  return { ok: true, message: lines.at(-1) ?? fallback }
}

/**
 * The remote's default branch as a remote-tracking ref (`origin/main`), read
 * from the local symref that `git clone` writes — **no network**, which is
 * what makes it usable on the path that cuts every new worktree.
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

/** `git fetch origin --prune`. Read-only against the working tree. */
export async function gitFetch(cwd: string): Promise<GitOpResult> {
  const remotes = await runGit(cwd, ['remote'])
  if (!remotes.stdout.trim()) return { ok: false, error: 'No remote configured' }
  const res = await runGit(cwd, ['fetch', 'origin', '--prune'], NETWORK_TIMEOUT_MS)
  return res.ok ? okWith(res, 'Fetched') : { ok: false, error: gitErrorOf(res) }
}

/**
 * Bring the default branch's new commits into this checkout, whichever kind it
 * is. One button, two honest meanings:
 *
 *  - **on the default branch** (the main checkout) — fetch and fast-forward.
 *    Never a merge or rebase: several agents share that checkout, and a
 *    conflict resolution there is one nobody asked for. Diverged means nothing
 *    moves and git says so.
 *  - **on a task branch** (a session's worktree) — fetch and merge
 *    `origin/<default>` in. Merging rather than rebasing because Ship pushes
 *    early, and rebasing a pushed branch means a force-push.
 *
 * A conflict leaves MERGE_HEAD behind, so it is aborted here: the agent
 * working in that checkout must never find it mid-merge.
 */
export async function gitUpdateFromBase(root: string): Promise<GitOpResult> {
  const cwd = resolveInsideRoots(root)
  if (!cwd) return { ok: false, error: `not readable: ${basename(root)}` }

  const fetched = await gitFetch(cwd)
  if (!fetched.ok) return fetched

  const base = await defaultRemoteRef(cwd)
  if (!base) return { ok: false, error: 'Could not tell which branch origin defaults to.' }

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { ok: false, error: gitErrorOf(head) }
  const branch = head.stdout.trim()
  if (branch === 'HEAD') return { ok: false, error: 'Detached HEAD — nothing to update.' }

  // `origin/main` → `main`: on that branch this is a plain fast-forward
  const onBase = branch === base.slice(base.indexOf('/') + 1)
  const res = await runGit(
    cwd,
    onBase ? ['merge', '--ff-only', base] : ['merge', '--no-edit', base],
    NETWORK_TIMEOUT_MS
  )
  if (res.ok) return okWith(res, `Up to date with ${base}`)

  const midMerge = await runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (midMerge.ok) {
    await runGit(cwd, ['merge', '--abort'])
    return {
      ok: false,
      error: `${gitErrorOf(res)}\n\nThe merge was aborted — this checkout is untouched.`
    }
  }
  return { ok: false, error: gitErrorOf(res) }
}
