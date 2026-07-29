import { basename } from 'node:path'
import { resolveInsideRoots } from './file-explorer'
import { gitErrorOf, runGit } from './git'

/**
 * The mutating half of git: branch switching and the remote round-trip
 * (fetch / pull / push). Kept out of `git.ts`, which is read-only by
 * contract, so "does this touch the repo?" stays answerable by file.
 *
 * Same rules as `worktrees.ts`: never --force, never -D, never stash, and
 * always surface git's own message verbatim — several agents share these
 * checkouts and a swallowed refusal is how work gets lost. Network calls
 * inherit GIT_TERMINAL_PROMPT=0 from runGit, so a missing credential fails
 * fast with git's text instead of hanging on an invisible prompt.
 */

export type GitOpResult = { ok: true; message: string } | { ok: false; error: string }

/** Network calls are slow but must not hang forever */
const NETWORK_TIMEOUT_MS = 120_000

/** A ref reaches git as an argv element — anything flag-shaped is refused */
function invalidRef(ref: string): string | null {
  if (!ref.trim()) return 'Branch name is required'
  if (ref.startsWith('-')) return 'Not a valid git ref'
  if (/[\s\x00-\x1f\x7f]/.test(ref)) return 'Branch names cannot contain spaces or control characters'
  return null
}

/** git's own answer to "is this a legal branch name?" — no rules duplicated here */
async function checkRefFormat(cwd: string, name: string): Promise<string | null> {
  const res = await runGit(cwd, ['check-ref-format', '--branch', name])
  return res.ok ? null : `Not a valid branch name: ${name}`
}

/**
 * Success lands in a one-line toast, so it gets git's last meaningful line —
 * the ref update, the diffstat, "Already up to date" — rather than the whole
 * transcript, which would collapse into a run-on sentence. Failures keep every
 * line; those render in the menu, where the detail is the point.
 */
const okWith = (r: { stdout: string; stderr: string }, fallback: string): GitOpResult => {
  // git puts progress and ref updates on stderr, results on stdout
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean)
  return { ok: true, message: lines.at(-1) ?? fallback }
}

// ---------- branch list ----------

export interface BranchInfo {
  /** Short name — `main`, `agent/foo`, or `origin/foo` for remotes */
  name: string
  /** Absolute path of the worktree holding it, when another checkout has it */
  worktree?: string
  upstream?: string
  /** From `%(upstream:track)`; both 0 when in sync or untracked */
  ahead: number
  behind: number
  /** Upstream branch is gone from the remote — the branch was merged & deleted */
  gone?: boolean
  /** Tip commit time, unix seconds — the list is sorted newest first */
  time: number
  subject: string
}

export type BranchListResult =
  | {
      ok: true
      /** Short branch name, or 'HEAD' when detached */
      current: string
      local: BranchInfo[]
      remote: BranchInfo[]
      /** True when `remote` was cut — the menu says so rather than implying completeness */
      remoteTruncated: boolean
    }
  | { ok: false; error: string }

/** A repo with a big remote can carry thousands of branches; the menu lists a page */
const MAX_REMOTE_BRANCHES = 300

/**
 * `%1f` / `%1e`, not the `%x1f` that `git log --format` takes: for-each-ref
 * spells a raw byte `%<hex>` and passes `%x1f` through as literal text, which
 * parses as one field and yields an empty branch list.
 */
const REF_FORMAT =
  '%(refname:short)%1f%(worktreepath)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(contents:subject)%1e'

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track.includes('gone')) return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false
  }
}

function parseRefs(stdout: string): BranchInfo[] {
  const out: BranchInfo[] = []
  for (const record of stdout.split('\x1e')) {
    const f = record.replace(/^\n/, '').split('\x1f')
    if (f.length < 6 || !f[0]) continue
    // `origin/HEAD` is a symref alias for the remote's default branch, not a branch
    if (f[0].endsWith('/HEAD')) continue
    const { ahead, behind, gone } = parseTrack(f[3])
    out.push({
      name: f[0],
      ...(f[1] && { worktree: f[1] }),
      ...(f[2] && { upstream: f[2] }),
      ahead,
      behind,
      ...(gone && { gone: true }),
      time: Number(f[4]) || 0,
      subject: f[5]
    })
  }
  return out
}

export async function gitBranches(root: string): Promise<BranchListResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }

  const [head, locals, remotes] = await Promise.all([
    runGit(real, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(real, ['for-each-ref', `--format=${REF_FORMAT}`, '--sort=-committerdate', 'refs/heads']),
    runGit(real, [
      'for-each-ref',
      `--format=${REF_FORMAT}`,
      '--sort=-committerdate',
      `--count=${MAX_REMOTE_BRANCHES + 1}`,
      'refs/remotes'
    ])
  ])
  if (!locals.ok) return { ok: false, error: gitErrorOf(locals) }

  const remote = parseRefs(remotes.stdout)
  return {
    ok: true,
    current: head.ok ? head.stdout.trim() : 'HEAD',
    local: parseRefs(locals.stdout),
    remote: remote.slice(0, MAX_REMOTE_BRANCHES),
    remoteTruncated: remote.length > MAX_REMOTE_BRANCHES
  }
}

// ---------- switching ----------

export interface CheckoutArgs {
  root: string
  /** Local branch, remote-tracking ref (`origin/foo`), or the name to create */
  ref: string
  /** Start a new branch at HEAD instead of switching to an existing one */
  create?: boolean
}

/**
 * Switch the checkout at `root`. Never forced: git refuses when the switch
 * would discard uncommitted work, or when another worktree already holds the
 * branch, and that refusal is passed straight through. Uncommitted changes
 * that *can* survive come along, which is git's normal behaviour.
 */
export async function gitCheckout({ root, ref, create }: CheckoutArgs): Promise<GitOpResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }
  const bad = invalidRef(ref)
  if (bad) return { ok: false, error: bad }

  if (create) {
    const badName = await checkRefFormat(real, ref)
    if (badName) return { ok: false, error: badName }
    const res = await runGit(real, ['switch', '-c', ref])
    return res.ok ? okWith(res, `Created ${ref}`) : { ok: false, error: gitErrorOf(res) }
  }

  const isLocal = await runGit(real, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`])
  if (!isLocal.ok) {
    const isRemote = await runGit(real, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`])
    if (isRemote.ok) {
      // `origin/foo` → local `foo`. If that local branch already exists it may
      // track something else entirely, so switch to it rather than re-tracking.
      const local = ref.slice(ref.indexOf('/') + 1)
      const localExists = await runGit(real, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${local}`
      ])
      const res = localExists.ok
        ? await runGit(real, ['switch', local])
        : await runGit(real, ['switch', '--track', ref])
      return res.ok ? okWith(res, `On ${local}`) : { ok: false, error: gitErrorOf(res) }
    }
  }

  const res = await runGit(real, ['switch', ref])
  return res.ok ? okWith(res, `On ${ref}`) : { ok: false, error: gitErrorOf(res) }
}

// ---------- remote ----------

/** `git fetch --all --prune` — read-only against the working tree */
export async function gitFetch(root: string): Promise<GitOpResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }
  const res = await runGit(real, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT_MS)
  return res.ok ? okWith(res, 'Fetched') : { ok: false, error: gitErrorOf(res) }
}

/**
 * `git pull --ff-only`. Fast-forward only on purpose: a merge or rebase pull
 * on a branch an agent is mid-way through is a conflict resolution nobody
 * asked for. When the branches have diverged git says so and nothing moves.
 */
export async function gitPull(root: string): Promise<GitOpResult> {
  const real = resolveInsideRoots(root)
  if (!real) return { ok: false, error: `not readable: ${basename(root)}` }
  const res = await runGit(real, ['pull', '--ff-only'], NETWORK_TIMEOUT_MS)
  return res.ok ? okWith(res, 'Up to date') : { ok: false, error: gitErrorOf(res) }
}

/**
 * `git push`. `setUpstream` is the caller's explicit choice, made in the UI
 * from the branch having no upstream — it is never inferred from a failed
 * push, because that would publish a branch on a retry the user didn't ask for.
 */
export async function gitPush(args: {
  root: string
  setUpstream?: boolean
}): Promise<GitOpResult> {
  const real = resolveInsideRoots(args.root)
  if (!real) return { ok: false, error: `not readable: ${basename(args.root)}` }

  let argv = ['push']
  if (args.setUpstream) {
    const head = await runGit(real, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = head.stdout.trim()
    if (!head.ok || branch === 'HEAD')
      return { ok: false, error: 'Detached HEAD — no branch to publish' }
    const remotes = await runGit(real, ['remote'])
    const remote = remotes.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
    if (remote.length === 0) return { ok: false, error: 'No remote configured' }
    argv = ['push', '--set-upstream', remote.includes('origin') ? 'origin' : remote[0], branch]
  }

  const res = await runGit(real, argv, NETWORK_TIMEOUT_MS)
  return res.ok ? okWith(res, 'Pushed') : { ok: false, error: gitErrorOf(res) }
}
