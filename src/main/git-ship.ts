import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { resolveInsideRoots } from './file-explorer'
import { gitErrorOf, runGit } from './git'
import { slugifyBranch, uniqueBranchName } from '../shared/branch-names'
import { willCutBranch, type ShipRoute } from '../shared/ship-route'
import { suggestCommitMessage, suggestPrText } from './git-text'
import { buildPtyEnv } from './terminals'

/**
 * "Ship" — the whole distance from a working tree to an open pull request in
 * one click: stage, commit, push, `gh pr create`. It exists because finishing
 * a piece of agent work was the one thing the app couldn't do; `git.ts` is
 * read-only and `git-ops.ts` stops at push.
 *
 * Same house rules as `git-ops.ts`: **never --force, never -D, never stash**,
 * and every failure carries git's or gh's own text verbatim. Two additions
 * those rules imply here:
 *
 *  - Nothing is ever committed onto the default branch. Shipping from `main`
 *    cuts a branch first and takes the changes with it (plain `git switch -c`,
 *    which is why no stash is needed) — main is left exactly as it was.
 *  - The whole thing is idempotent. A second click on an unchanged tree says
 *    "nothing to ship"; a second click after more work pushes onto the PR that
 *    is already open rather than opening another.
 *
 * The prose (commit subject, PR body) comes from `git-text.ts`, which always
 * falls back to a plain generated string — an unavailable agent must never be
 * the reason a change can't ship.
 */

export interface ShipSuccess {
  ok: true
  /** The PR this landed in — created, updated, or already open on the base. Empty when there is none. */
  url: string
  branch: string
  base: string
  route: ShipRoute
  /** A commit was made (false when the tree was already clean and just needed pushing) */
  committed: boolean
  /** The PR was opened by this run; false means it already existed and was updated */
  created: boolean
  /** Set when the branch was cut by this run because HEAD was the base branch */
  branchedFrom?: string
}

export type ShipResult = ShipSuccess | { ok: false; error: string }

/** Network calls are slow but must not hang forever — matches git-ops.ts */
const NETWORK_TIMEOUT_MS = 120_000

// ---------- gh ----------

/**
 * `gh` is a Homebrew binary and Electron's PATH is not the login shell's, so
 * an absolute path is resolved once through the user's own shell — the same
 * reason `agent-runner.ts` spawns through `/bin/zsh -ilc`. Resolving it up
 * front (rather than running every gh call through a shell) keeps arguments in
 * argv, so a PR body full of backticks and quotes needs no escaping.
 */
let ghPath: string | null | undefined

function shellLookup(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-ilc', `command -v ${bin}`],
      { timeout: 15_000, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null)
    )
  })
}

interface Exec {
  ok: boolean
  stdout: string
  stderr: string
}

async function runGh(cwd: string, args: string[], timeoutMs = 60_000): Promise<Exec> {
  if (ghPath === undefined) ghPath = await shellLookup('gh')
  if (!ghPath) return { ok: false, stdout: '', stderr: 'gh-not-found' }
  return new Promise((resolve) => {
    execFile(
      ghPath as string,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: buildPtyEnv(process.env) },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })
}

const ghErrorOf = (r: Exec): string => r.stderr.trim() || r.stdout.trim() || 'gh failed'

const NOT_INSTALLED =
  'GitHub CLI (gh) isn’t installed — `brew install gh`, then `gh auth login`.'
const NOT_AUTHED = 'GitHub CLI isn’t signed in — run `gh auth login` in a terminal.'

/** Both failure modes read as "gh broke" without this; they need different fixes. */
async function ghReady(cwd: string): Promise<string | null> {
  const auth = await runGh(cwd, ['auth', 'status'])
  if (auth.ok) return null
  return auth.stderr === 'gh-not-found' ? NOT_INSTALLED : NOT_AUTHED
}

// ---------- repo facts ----------

/**
 * The branch a PR should target. GitHub's own answer, because a repo whose
 * default is `master`, `develop` or `trunk` is common enough that hardcoding
 * `main` would open PRs against a branch that doesn't exist.
 */
export async function defaultBranch(cwd: string): Promise<string> {
  const res = await runGh(cwd, ['repo', 'view', '--json', 'defaultBranchRef'])
  if (!res.ok) return 'main'
  try {
    const parsed = JSON.parse(res.stdout) as { defaultBranchRef?: { name?: string } }
    return parsed.defaultBranchRef?.name || 'main'
  } catch {
    return 'main'
  }
}

/** Local branch names — what a generated name must not collide with. */
async function localBranches(cwd: string): Promise<string[]> {
  const res = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return res.ok ? res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
}

/**
 * Branches a PR could target. Remote-tracking refs only: a base has to exist
 * on the remote for GitHub to compare against, and a local-only `develop` that
 * was never pushed would be offered as a target `gh` then rejects.
 *
 * Read from refs rather than the API — offline, instant, and current as of the
 * fetch that cutting the session already did.
 */
async function remoteBases(cwd: string): Promise<string[]> {
  const res = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/remotes'
  ])
  if (!res.ok) return []
  const names = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    // `origin/HEAD` is a symref alias for the default branch, not a branch
    .filter((n) => !n.endsWith('/HEAD'))
    // `origin/release/2.1` → `release/2.1`; the remote is chosen at push time
    .map((n) => n.slice(n.indexOf('/') + 1))
  return [...new Set(names)]
}

/** Whether the branch already exists on the remote — i.e. renaming it is too late. */
async function isPushed(cwd: string, branch: string): Promise<boolean> {
  const remote = await pushRemote(cwd)
  const res = await runGit(cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/${remote}/${branch}`
  ])
  return res.ok
}

/**
 * git's own answer, because the rules are more than a character class
 * (no `..`, no trailing `.lock`, no `@{`, no control characters). The two
 * hand-written guards in front of it cover what `--branch` would otherwise
 * *accept by expanding*: `-x` reads as a flag, and `@{-1}` is a valid ref
 * expression naming the previously checked-out branch rather than a new name.
 */
export async function invalidBranchName(cwd: string, name: string): Promise<string | null> {
  if (!name.trim()) return 'Branch name is required'
  if (name.startsWith('-') || name.includes('@{'))
    return `Not a valid branch name: ${name}`
  const res = await runGit(cwd, ['check-ref-format', '--branch', name])
  return res.ok ? null : `Not a valid branch name: ${name}`
}

/** `origin/main` when it has been fetched, else `main` — the diff base for PR text. */
async function comparisonRef(cwd: string, base: string): Promise<string> {
  const remote = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`])
  return remote.ok ? `origin/${base}` : base
}

/**
 * The branch name a PR can target, from a base ref as it was recorded.
 *
 * A session's PR belongs where its branch was cut from: a worktree started
 * from `dev/updates` that opens a PR into `main` is a PR nobody asked for, and
 * it is invisible until someone wonders why the work never deployed. The start
 * point is on `Worktree.baseBranch`, but stored the way git named it —
 * `origin/dev/updates` for a remote-tracking one, `dev/updates` for a local
 * branch — while a PR base is a branch *name*. Whether to strip a prefix is
 * asked of git rather than matched on `origin/`, because a remote can be
 * called anything and `feature/login` is a local branch, not a remote called
 * `feature`.
 *
 * A base GitHub has never seen is no use to `gh pr create`, so a base that
 * resolves to no remote branch falls back to the repo's default — the ship
 * lands somewhere sensible instead of failing on its last step, and the modal
 * shows which target it settled on before anything is pushed.
 */
export async function resolveBase(
  cwd: string,
  raw: string | undefined,
  repoDefault: string
): Promise<string> {
  const base = raw?.trim()
  if (!base) return repoDefault
  const slash = base.indexOf('/')
  const tracking =
    slash > 0 &&
    (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${base}`])).ok
  const name = tracking ? base.slice(slash + 1) : base
  const remote = await pushRemote(cwd)
  const onRemote = await runGit(cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/${remote}/${name}`
  ])
  return onRemote.ok ? name : repoDefault
}

// ---------- preview ----------

export interface ShipPreview {
  ok: true
  branch: string
  base: string
  /** The repo's own default — the branch that is protected from commits whatever the base is */
  repoDefault: string
  /** Every branch a PR could target, base first */
  bases: string[]
  /** Already on the remote, so the branch name is fixed — renaming it now would orphan it */
  pushed: boolean
  /** HEAD is a protected branch, so shipping cuts a branch first */
  willBranch: boolean
  /** Paths that would be committed — `git add -A`, so everything not ignored */
  files: Array<{ path: string; status: string }>
  /** `git log --oneline base..HEAD` — already committed, waiting to be pushed */
  commits: string[]
  /** Pre-filled and editable; the agent is asked here so Ship itself is instant */
  subject: string
  body: string
  prTitle: string
  prBody: string
  /** URL of the PR this would push onto, if one is already open */
  existingPr: string | null
  nothingToDo: boolean
}

export type ShipPreviewResult = ShipPreview | { ok: false; error: string }

/**
 * Everything Ship is about to do, computed **without doing any of it**.
 *
 * The no-side-effects rule is the whole point: this is what you read before
 * you agree, so it must not stage, commit or push. That costs a little
 * fidelity — the commit message is written from `git diff HEAD` plus the names
 * of untracked files rather than from a staged diff, because staging to look
 * at something and then leaving it staged when you cancel would be worse. It
 * costs nothing in the end, since Ship commits the message you confirmed here
 * rather than generating a second one.
 */
export async function shipPreview(args: {
  root: string
  /** Re-read against a different PR target; omitted means the repo's default */
  base?: string
}): Promise<ShipPreviewResult> {
  const cwd = resolveInsideRoots(args.root)
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` }

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(args.root)} is not a git repository` }
  const headCommit = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!headCommit.ok)
    return { ok: false, error: 'This repository has no commits yet — make one first.' }

  const notReady = await ghReady(cwd)
  if (notReady) return { ok: false, error: notReady }

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = head.stdout.trim()
  if (!head.ok || branch === 'HEAD')
    return { ok: false, error: 'Detached HEAD — check out a branch before shipping.' }

  // Two API round-trips and a working-tree scan, none of which needs the
  // others. Run in sequence this is most of the wait before the dialog opens.
  // `-uall` lists files inside an untracked directory rather than the directory
  // alone — this is a review surface, and "packages/foo/" hides how much is
  // actually about to be committed.
  const [repoDefault, existingPr, status, remotes, pushed] = await Promise.all([
    defaultBranch(cwd),
    openPrUrl(cwd, branch),
    runGit(cwd, ['status', '--porcelain', '-uall']),
    remoteBases(cwd),
    isPushed(cwd, branch)
  ])
  const base = await resolveBase(cwd, args.base, repoDefault)
  // The branch being shipped is never a target for itself
  const bases = [...new Set([base, repoDefault, ...remotes])].filter((b) => b !== branch)
  const compare = await comparisonRef(cwd, base)
  // Committing onto the repo's default is refused whatever the chosen target
  // is, and a PR from a branch into itself is not a thing either
  const willBranch = branch === base || branch === repoDefault

  const files = status.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3).trim() }))

  const log = await runGit(cwd, ['log', '--oneline', `${compare}..HEAD`])
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : []

  const nothingToDo = files.length === 0 && commits.length === 0
  if (nothingToDo)
    return {
      ok: true,
      branch,
      base,
      repoDefault,
      bases,
      pushed,
      willBranch: false,
      files,
      commits,
      subject: '',
      body: '',
      prTitle: '',
      prBody: '',
      existingPr,
      nothingToDo
    }

  const [stat, text, diffStat] = await Promise.all([
    runGit(cwd, ['diff', '--stat', 'HEAD']),
    runGit(cwd, ['diff', 'HEAD']),
    runGit(cwd, ['diff', '--stat', `${compare}...HEAD`])
  ])
  const untracked = files.filter((f) => f.status === '??').map((f) => `  ${f.path} (new)`)

  /**
   * The dialog waits on this, so the model is asked as little as possible.
   *
   * A branch with no prior commits — the common case, since a session cuts a
   * fresh worktree — has exactly one commit's worth of story to tell, and its
   * PR title *is* that commit's subject. Asking a second time would be a
   * second CLI spawn to paraphrase text we already have. When there is real
   * history to summarise, the two calls at least run concurrently rather than
   * one waiting on the other.
   */
  const wantsCommit = files.length > 0
  const wantsPr = commits.length > 0
  const [message, prText] = await Promise.all([
    wantsCommit
      ? suggestCommitMessage(
          [stat.stdout.trimEnd(), ...untracked].filter(Boolean).join('\n'),
          text.stdout,
          files.length
        )
      : Promise.resolve(null),
    wantsPr ? suggestPrText(branch, commits, diffStat.stdout.trimEnd()) : Promise.resolve(null)
  ])

  const subject = message?.subject ?? ''
  const body = message?.body ?? ''
  const pr = prText ?? { title: subject, body: body || subject }

  return {
    ok: true,
    branch,
    base,
    repoDefault,
    bases,
    pushed,
    willBranch,
    files,
    commits,
    subject,
    body,
    prTitle: pr.title,
    prBody: pr.body,
    existingPr,
    nothingToDo
  }
}

/**
 * What moving the PR target does to the change, without re-reading anything
 * else. Retargeting a branch cut from `main` at `develop` pulls in every
 * commit `develop` is missing, which is the one number worth seeing *before*
 * you agree — but it is a local `git log`, so it must not cost the model call
 * the full preview pays for. The commit message describes the working tree and
 * doesn't move with the base at all.
 */
export async function shipCompare(args: {
  root: string
  base: string
}): Promise<{ ok: true; commits: string[] } | { ok: false; error: string }> {
  const cwd = resolveInsideRoots(args.root)
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` }
  const compare = await comparisonRef(cwd, args.base)
  const log = await runGit(cwd, ['log', '--oneline', `${compare}..HEAD`])
  if (!log.ok) return { ok: false, error: gitErrorOf(log) }
  return { ok: true, commits: log.stdout.split('\n').filter(Boolean) }
}

// ---------- the pipeline ----------

export interface ShipArgs {
  root: string
  /** Confirmed in the review modal — skips asking the agent a second time */
  message?: { subject: string; body: string }
  pr?: { title: string; body: string }
  /** PR target; omitted means the repo's default branch */
  base?: string
  /** Omitted means `pr` — the direct push is never the route by default */
  route?: ShipRoute
  /**
   * Rename the branch before shipping it. Refused once the branch is on the
   * remote — the old ref would be left behind with the PR still pointing at
   * it, and cleaning that up means deleting a remote branch.
   */
  renameBranch?: string
}

export async function shipPullRequest(args: ShipArgs): Promise<ShipResult> {
  const cwd = resolveInsideRoots(args.root)
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` }

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { ok: false, error: `${basename(args.root)} is not a git repository` }

  const headCommit = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!headCommit.ok)
    return { ok: false, error: 'This repository has no commits yet — make one first.' }

  const notReady = await ghReady(cwd)
  if (notReady) return { ok: false, error: notReady }

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { ok: false, error: gitErrorOf(head) }
  let branch = head.stdout.trim()
  if (branch === 'HEAD')
    return { ok: false, error: 'Detached HEAD — check out a branch before shipping.' }

  const repoDefault = await defaultBranch(cwd)
  const base = await resolveBase(cwd, args.base, repoDefault)
  const route: ShipRoute = args.route === 'push' ? 'push' : 'pr'
  const protectedHead = willCutBranch(route, branch, base, repoDefault)

  const wanted = args.renameBranch?.trim()
  if (wanted && wanted !== branch) {
    const bad = await invalidBranchName(cwd, wanted)
    if (bad) return { ok: false, error: bad }
    if ((await localBranches(cwd)).includes(wanted))
      return { ok: false, error: `A branch named ${wanted} already exists.` }
  }

  // ---- rename ----
  //
  // Before anything else, so the commit, the push and the PR all see one name.
  // Renaming is a local ref move (`branch -m`) and is only safe while the
  // branch *is* local: once it is pushed, the remote keeps the old name and any
  // PR stays attached to it, so "renaming" would mean deleting a remote branch
  // — the --force/-D territory this file exists to stay out of.
  //
  // A protected head is not renamed but *branched from*, so the same field
  // names the branch the stage below cuts rather than moving `main`.
  if (wanted && wanted !== branch && !protectedHead) {
    if (await isPushed(cwd, branch))
      return {
        ok: false,
        error: `${branch} is already on the remote — rename it there, or ship it under this name.`
      }
    const moved = await runGit(cwd, ['branch', '-m', wanted])
    if (!moved.ok) return { ok: false, error: gitErrorOf(moved) }
    branch = wanted
  }

  // ---- stage ----
  //
  // Everything not ignored, which is what a one-click ship means. Staging
  // before the branch decision is deliberate: `git switch -c` carries the index
  // across, so one `git diff --cached` is the single source of truth for both
  // the commit message and the generated branch name.
  const add = await runGit(cwd, ['add', '-A'])
  if (!add.ok) return { ok: false, error: gitErrorOf(add) }

  const staged = await runGit(cwd, ['diff', '--cached', '--name-only'])
  const stagedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const hasChanges = stagedFiles.length > 0

  let branchedFrom: string | undefined
  let committed = false

  if (hasChanges) {
    let message = args.message
    if (!message) {
      const stat = await runGit(cwd, ['diff', '--cached', '--stat'])
      const text = await runGit(cwd, ['diff', '--cached'])
      message = await suggestCommitMessage(stat.stdout.trimEnd(), text.stdout, stagedFiles.length)
    }

    if (protectedHead) {
      // The typed name wins; the slug is the fallback for a one-click ship
      const name =
        wanted ||
        uniqueBranchName(slugifyBranch(message.subject) || 'changes', await localBranches(cwd))
      const cut = await runGit(cwd, ['switch', '-c', name])
      if (!cut.ok) return { ok: false, error: gitErrorOf(cut) }
      branchedFrom = branch
      branch = name
    }

    const argv = ['commit', '-m', message.subject]
    if (message.body) argv.push('-m', message.body)
    const commit = await runGit(cwd, argv)
    if (!commit.ok) return { ok: false, error: gitErrorOf(commit) }
    committed = true
  } else if (protectedHead) {
    return {
      ok: false,
      error: `Nothing to ship — no changes, and ${branch} is a branch PRs land on.`
    }
  }

  // ---- push ----
  const compare = await comparisonRef(cwd, base)
  const ahead = await runGit(cwd, ['rev-list', '--count', `${compare}..HEAD`])
  // A count git couldn't produce is unknown, not zero — refusing to ship on a
  // failed `rev-list` would strand real commits behind a "nothing to do"
  const commitsAhead = ahead.ok ? Number(ahead.stdout.trim()) || 0 : -1

  // Which PR this run affects: the one on our own branch when opening one, the
  // one already open on the base when pushing into it — that second case is
  // how "fix a mistake on a branch under review" reports where the work went.
  const existing = await openPrUrl(cwd, route === 'push' ? base : branch)
  if (!committed && commitsAhead === 0)
    return {
      ok: false,
      error: existing
        ? 'Nothing to ship — the PR is already up to date.'
        : `Nothing to ship — ${branch} has no commits ${base} lacks.`
    }

  /**
   * The direct route. `HEAD:refs/heads/<base>` needs no checkout and moves no
   * local ref, so the base can be checked out in another worktree — or be a
   * branch this clone has never had — and nothing here disturbs it.
   *
   * There is no `--force` and there will not be: git refuses a push that isn't
   * a fast-forward, which is exactly the guard wanted. If someone else moved
   * the base, the refusal is the signal to update from it and ship again.
   */
  if (route === 'push') {
    const pushed = await runGit(
      cwd,
      ['push', await pushRemote(cwd), `HEAD:refs/heads/${base}`],
      NETWORK_TIMEOUT_MS
    )
    if (!pushed.ok) return { ok: false, error: gitErrorOf(pushed) }
    return {
      ok: true,
      url: existing ?? '',
      branch,
      base,
      route,
      committed,
      created: false,
      ...(branchedFrom && { branchedFrom })
    }
  }

  const tracksSelf = await tracksOwnBranch(cwd, branch)

  const push = tracksSelf
    ? await runGit(cwd, ['push'], NETWORK_TIMEOUT_MS)
    : await runGit(cwd, ['push', '--set-upstream', await pushRemote(cwd), branch], NETWORK_TIMEOUT_MS)
  if (!push.ok) return { ok: false, error: gitErrorOf(push) }

  // ---- pull request ----
  if (existing)
    return { ok: true, url: existing, branch, base, route, committed, created: false, ...(branchedFrom && { branchedFrom }) }

  const log = await runGit(cwd, ['log', '--oneline', `${compare}..HEAD`])
  const diffStat = await runGit(cwd, ['diff', '--stat', `${compare}...HEAD`])
  const pr =
    args.pr ??
    (await suggestPrText(
      branch,
      log.ok ? log.stdout.split('\n').filter(Boolean) : [],
      diffStat.stdout.trimEnd()
    ))

  const created = await runGh(
    cwd,
    ['pr', 'create', '--base', base, '--head', branch, '--title', pr.title, '--body', pr.body || pr.title],
    NETWORK_TIMEOUT_MS
  )
  if (!created.ok) {
    // gh refuses when a PR already exists; the push above still landed, so
    // recover its URL rather than reporting a failure for work that shipped
    const raced = await openPrUrl(cwd, branch)
    if (raced)
      return { ok: true, url: raced, branch, base, route, committed, created: false, ...(branchedFrom && { branchedFrom }) }
    return { ok: false, error: ghErrorOf(created) }
  }

  const url = created.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return { ok: true, url, branch, base, route, committed, created: true, ...(branchedFrom && { branchedFrom }) }
}

/**
 * Branch names whose PR has already been merged. One call for the whole repo
 * rather than one per worktree: this runs on every sidebar reconcile (which
 * fires on window focus), and a network round-trip per isolated branch would
 * make focusing the window cost a second.
 *
 * An empty answer is indistinguishable from "gh is unreachable" on purpose —
 * both mean *don't reap anything*, which is the safe direction for a function
 * whose output deletes checkouts.
 */
export async function mergedBranches(root: string): Promise<string[]> {
  const cwd = resolveInsideRoots(root)
  if (!cwd) return []
  const res = await runGh(cwd, [
    'pr',
    'list',
    '--state',
    'merged',
    '--json',
    'headRefName',
    '--limit',
    '100'
  ])
  if (!res.ok) return []
  try {
    const rows = JSON.parse(res.stdout) as Array<{ headRefName?: string }>
    return rows.map((r) => r.headRefName).filter((n): n is string => Boolean(n))
  } catch {
    return []
  }
}

/** URL of the open PR for `branch`, or null. */
async function openPrUrl(cwd: string, branch: string): Promise<string | null> {
  const res = await runGh(cwd, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'url',
    '--limit',
    '1'
  ])
  if (!res.ok) return null
  try {
    const rows = JSON.parse(res.stdout) as Array<{ url?: string }>
    return rows[0]?.url ?? null
  } catch {
    return null
  }
}

/**
 * Whether the branch's upstream is *its own* remote branch, which is the only
 * case a bare `git push` handles.
 *
 * Having an upstream is not enough: cutting a worktree from `origin/<default>`
 * makes git's `autoSetupMerge` point the task branch at `refs/heads/main`, so
 * `@{u}` resolves and `git push` then dies with *the upstream branch of your
 * current branch does not match the name of your current branch*. Falling
 * through to `--set-upstream` both pushes and repoints it.
 */
async function tracksOwnBranch(cwd: string, branch: string): Promise<boolean> {
  const merge = await runGit(cwd, ['config', '--get', `branch.${branch}.merge`])
  return merge.ok && merge.stdout.trim() === `refs/heads/${branch}`
}

/** `origin` when it exists, else whatever remote the repo does have. */
async function pushRemote(cwd: string): Promise<string> {
  const res = await runGit(cwd, ['remote'])
  const remotes = res.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin')
}
