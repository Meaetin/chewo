import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { resolveInsideRoots } from './file-explorer'
import { gitErrorOf, runGit } from './git'
import { slugifyBranch, uniqueBranchName } from '../shared/branch-names'
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
  url: string
  branch: string
  base: string
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

/** `origin/main` when it has been fetched, else `main` — the diff base for PR text. */
async function comparisonRef(cwd: string, base: string): Promise<string> {
  const remote = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`])
  return remote.ok ? `origin/${base}` : base
}

// ---------- preview ----------

export interface ShipPreview {
  ok: true
  branch: string
  base: string
  /** HEAD is the base branch, so shipping cuts a branch first */
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
export async function shipPreview(args: { root: string }): Promise<ShipPreviewResult> {
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
  const [base, existingPr, status] = await Promise.all([
    defaultBranch(cwd),
    openPrUrl(cwd, branch),
    runGit(cwd, ['status', '--porcelain', '-uall'])
  ])
  const compare = await comparisonRef(cwd, base)

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
    willBranch: branch === base,
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

// ---------- the pipeline ----------

export interface ShipArgs {
  root: string
  /** Confirmed in the review modal — skips asking the agent a second time */
  message?: { subject: string; body: string }
  pr?: { title: string; body: string }
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

  const base = await defaultBranch(cwd)

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

    // Never commit onto the default branch — cut one and take the index along
    if (branch === base) {
      const name = uniqueBranchName(
        slugifyBranch(message.subject) || 'changes',
        await localBranches(cwd)
      )
      const cut = await runGit(cwd, ['switch', '-c', name])
      if (!cut.ok) return { ok: false, error: gitErrorOf(cut) }
      branchedFrom = base
      branch = name
    }

    const argv = ['commit', '-m', message.subject]
    if (message.body) argv.push('-m', message.body)
    const commit = await runGit(cwd, argv)
    if (!commit.ok) return { ok: false, error: gitErrorOf(commit) }
    committed = true
  } else if (branch === base) {
    return {
      ok: false,
      error: `Nothing to ship — no changes, and ${base} is the branch PRs land on.`
    }
  }

  // ---- push ----
  const compare = await comparisonRef(cwd, base)
  const upstream = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const ahead = await runGit(cwd, ['rev-list', '--count', `${compare}..HEAD`])
  // A count git couldn't produce is unknown, not zero — refusing to ship on a
  // failed `rev-list` would strand real commits behind a "nothing to do"
  const commitsAhead = ahead.ok ? Number(ahead.stdout.trim()) || 0 : -1

  const existing = await openPrUrl(cwd, branch)
  if (!committed && commitsAhead === 0)
    return {
      ok: false,
      error: existing
        ? 'Nothing to ship — the PR is already up to date.'
        : `Nothing to ship — ${branch} has no commits ${base} lacks.`
    }

  const push = upstream.ok
    ? await runGit(cwd, ['push'], NETWORK_TIMEOUT_MS)
    : await runGit(cwd, ['push', '--set-upstream', await pushRemote(cwd), branch], NETWORK_TIMEOUT_MS)
  if (!push.ok) return { ok: false, error: gitErrorOf(push) }

  // ---- pull request ----
  if (existing)
    return { ok: true, url: existing, branch, base, committed, created: false, ...(branchedFrom && { branchedFrom }) }

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
      return { ok: true, url: raced, branch, base, committed, created: false, ...(branchedFrom && { branchedFrom }) }
    return { ok: false, error: ghErrorOf(created) }
  }

  const url = created.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return { ok: true, url, branch, base, committed, created: true, ...(branchedFrom && { branchedFrom }) }
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

/** `origin` when it exists, else whatever remote the repo does have. */
async function pushRemote(cwd: string): Promise<string> {
  const res = await runGit(cwd, ['remote'])
  const remotes = res.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin')
}
