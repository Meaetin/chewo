/**
 * Turning a sentence into a git branch name, locally and instantly.
 *
 * Deliberately not an agent call. This runs on the first message of every
 * isolated session and again inside Ship, and a CLI spawn costs a second or
 * two, a session file in the sidebar, and a failure mode — for an answer a
 * regex matches: measured against the real thing, "test" came back as "test".
 * The agent still writes commit messages and PR bodies, where summarising a
 * diff is genuine work; naming five words is not.
 *
 * Shared rather than in `src/main` because both ends need it: the renderer
 * names a worktree when a session first speaks, and `git-ship.ts` names the
 * branch it cuts when you ship from the default branch.
 */

/**
 * Words that carry no signal in a branch name. Kept small on purpose —
 * over-trimming turns "run the tests" into "tests".
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'be', 'can', 'you', 'please', 'i', 'we', 'it', 'this',
  'that', 'my', 'our', 'lets', 'let', "let's"
])

/**
 * Non-ASCII is dropped rather than transliterated: the result is both an argv
 * element and a directory name, and half-transliterated unicode is worse than
 * a shorter English slug. Anything path-like collapses to its words, so an
 * agent-authored or pasted `../../etc/passwd` can only ever become
 * `etc-passwd`.
 */
export function slugifyBranch(text: string, maxWords = 5): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
  const meaningful = words.filter((w) => !STOP_WORDS.has(w))
  // If stripping stop words emptied it ("can you please"), keep the raw words
  const picked = (meaningful.length ? meaningful : words).slice(0, maxWords)
  return picked.join('-').slice(0, 48).replace(/-+$/, '')
}

/**
 * `name`, `name-2`, `name-3`… against names already in use. Suffixing rather
 * than failing matters here: the name comes from a sentence, and two sessions
 * about the same bug is exactly when a collision happens.
 */
export function uniqueBranchName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * The whole naming decision: slug the task, fall back to something usable when
 * it slugs away to nothing, and dodge names already taken. `taken` should be
 * every task name in the project — main validates the result again when it
 * creates the worktree, so this layer only has to produce a plausible one.
 */
export function branchNameFor(task: string, taken: Iterable<string> = []): string {
  return uniqueBranchName(slugifyBranch(task) || 'task', taken)
}
