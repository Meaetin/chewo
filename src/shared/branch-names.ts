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

const MAX_CHARS = 48

/**
 * Non-ASCII is dropped rather than transliterated: the result is both an argv
 * element and a directory name, and half-transliterated unicode is worse than
 * a shorter English slug. Anything path-like collapses to its words, so an
 * agent-authored or pasted `../../etc/passwd` can only ever become
 * `etc-passwd`.
 *
 * An apostrophe is an elision, not a word boundary — dropping it rather than
 * turning it into a space is what keeps `picker's` from becoming `picker-s`,
 * where the orphaned `s` reads as noise *and* spends one of the word slots.
 * The character cap packs whole words, because slicing the joined string cuts
 * mid-word and leaves a slug that looks like a typo.
 */
export function slugifyBranch(text: string, maxWords = 5): string {
  const words = text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
  const meaningful = words.filter((w) => !STOP_WORDS.has(w))
  // If stripping stop words emptied it ("can you please"), keep the raw words
  const picked = (meaningful.length ? meaningful : words).slice(0, maxWords)
  const kept: string[] = []
  let len = 0
  for (const word of picked) {
    const next = kept.length ? len + 1 + word.length : word.length
    if (kept.length && next > MAX_CHARS) break
    kept.push(word)
    len = next
  }
  return kept.join('-').slice(0, MAX_CHARS)
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

/** `feat(api): add oauth callback` → type `feat`, rest `add oauth callback`. */
const CONVENTIONAL = /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*(.+)$/i

/**
 * A branch name for work that has already been described — Ship's commit
 * subject, which a model wrote from the actual diff.
 *
 * This is why Ship can suggest a *good* name where a session start cannot: at
 * session start all that exists is the task you typed, but by the time you
 * ship, the change itself has been read and summarised. So the name comes off
 * that summary rather than costing a second call to re-derive it.
 *
 * A conventional-commit type becomes the branch prefix (`feat: add oauth` →
 * `feat/add-oauth`), which is the convention the subject is already written in
 * — anything else is slugged flat. The scope is dropped: `feat(api)` would
 * give `feat/api/…`, and a three-level branch name reads as a directory.
 *
 * The word budget is wider than a task slug's because a subject is already a
 * summary rather than a sentence someone typed at an agent, and the character
 * cap is the real limit. `describeChange` handles the other half: a subject
 * describing two changes ("…two modes, drop the local twin") is cut at the
 * first clause, since five words spent on half a sentence names nothing.
 */
const SUBJECT_WORDS = 8

/** The first clause, when it still says something on its own. */
function describeChange(text: string): string {
  const clause = text.split(/\s*[,;—]\s*/)[0]
  const slug = slugifyBranch(clause, SUBJECT_WORDS)
  return slug.includes('-') ? slug : slugifyBranch(text, SUBJECT_WORDS)
}

export function branchNameFromSubject(subject: string): string {
  const match = CONVENTIONAL.exec(subject.trim())
  if (!match) return describeChange(subject)
  const slug = describeChange(match[3])
  return slug ? `${match[1].toLowerCase()}/${slug}` : describeChange(subject)
}
