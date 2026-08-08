import { basename } from 'node:path'
import { resolveInsideRoots } from './file-explorer'
import { gitErrorOf, runGit, safePathspec } from './git'

/**
 * Throwing work away — the fourth mutating git file, split from the others by
 * blast radius the same way they are split from each other: `git-ops.ts`
 * brings commits in, `git-ship.ts` sends work out, `worktrees.ts` manages
 * checkouts, and this destroys uncommitted changes.
 *
 * It is the one place in the app where losing work is the *point*, so the
 * house rules bend here exactly as they do for abandoning a worktree
 * (`removeWorktree(discard)`): `git clean -f` is a force flag, and it is
 * allowed because a person was shown what they were about to lose and asked
 * for it anyway. What does not bend: nothing here touches a commit. A discard
 * can cost you an afternoon of uncommitted edits, never a commit — `git reset`
 * and `git checkout <commit>` are deliberately absent, so anything that
 * reached a commit is still recoverable from the reflog.
 *
 * The status re-read below is not belt-and-braces. Several agents write these
 * checkouts continuously, so the panel's list is a photograph: by the time a
 * row is clicked the file may be staged, may have become a different kind of
 * change, or may already be gone. Classifying from a fresh read means the
 * command matches the file's actual state rather than the state it was drawn
 * in — and a path that is no longer changed at all is skipped rather than
 * being restored from HEAD, which would revert a change nobody asked about.
 */

export interface DiscardResult {
  ok: boolean
  /** Paths whose changes were thrown away */
  discarded: string[]
  /** Listed but no longer changed by the time git was asked — left alone */
  skipped: string[]
  error?: string
}

/** How a path has to be un-changed, which is not the same for all of them. */
type Kind =
  /** Never committed: the change *is* the file, so discarding means deleting it */
  | 'untracked'
  /** Staged as new: unstage first, which leaves an untracked file to delete */
  | 'added'
  /** In HEAD: the file comes back from there, index and working tree together */
  | 'tracked'

/**
 * `git status --porcelain=v1 -z`, read as `XY <path>` records.
 *
 * v1 rather than the v2 the panel parses: this needs the two status letters
 * and the path and nothing else, and v1's `-z` records are one field each
 * where v2's carry six. `-z` because a path with a newline or a quote in it is
 * legal and would otherwise arrive quoted and escaped.
 *
 * Renames are the reason for the `origPath` half: a v1 rename record is
 * `R  <new>\0<old>\0`, two NUL-terminated fields for one entry, so a parser
 * that treats every record as one path silently reads the old path as a
 * separate file.
 */
async function readStatus(cwd: string): Promise<Map<string, Kind> | string> {
  const res = await runGit(cwd, ['status', '--porcelain=v1', '-z', '-unormal'])
  if (!res.ok) return gitErrorOf(res)

  const out = new Map<string, Kind>()
  const parts = res.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    // A rename's source path is the *next* record; consume it so it is not
    // read as a file of its own
    if (x === 'R' || x === 'C') i++
    if (x === '?' && y === '?') out.set(path, 'untracked')
    else if (x === 'A') out.set(path, 'added')
    else out.set(path, 'tracked')
  }
  return out
}

/**
 * Throw away the working-tree changes to `paths`.
 *
 * Directories are accepted as they come out of `git status`, which collapses a
 * wholly-untracked one into a single entry with a trailing slash — the panel
 * shows it as one row, so it has to be discardable as one row.
 */
export async function discardChanges(root: string, paths: string[]): Promise<DiscardResult> {
  const cwd = resolveInsideRoots(root)
  if (!cwd) return { ok: false, discarded: [], skipped: [], error: `not readable: ${basename(root)}` }
  if (paths.length === 0) return { ok: true, discarded: [], skipped: [] }
  // Every path is an argv element and reaches commands that delete files
  if (!paths.every(safePathspec))
    return { ok: false, discarded: [], skipped: [], error: 'invalid path' }

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok)
    return { ok: false, discarded: [], skipped: [], error: `${basename(root)} is not a git repository` }

  const status = await readStatus(cwd)
  if (typeof status === 'string') return { ok: false, discarded: [], skipped: [], error: status }

  /**
   * The directories `git status -unormal` collapsed, which is what the panel's
   * expandable folder rows are made of. A file inside one has **no status
   * entry of its own** — status names the folder and stops — so looking a
   * child up by its own path finds nothing, and it would be skipped as "not
   * changed" when it is in fact an untracked file the panel is offering to
   * delete. Everything under such a folder is untracked by definition.
   */
  const collapsed = [...status.keys()].filter((p) => p.endsWith('/'))

  const untracked: string[] = []
  const added: string[] = []
  const tracked: string[] = []
  const skipped: string[] = []

  for (const path of paths) {
    const kind =
      status.get(path) ??
      (path.endsWith('/') || collapsed.some((d) => path.startsWith(d)) ? 'untracked' : undefined)
    if (kind === 'untracked') untracked.push(path)
    else if (kind === 'added') added.push(path)
    else if (kind === 'tracked') tracked.push(path)
    else skipped.push(path)
  }

  const discarded: string[] = []
  const fail = (msg: string): DiscardResult => ({ ok: false, discarded, skipped, error: msg })

  // Restore from HEAD — index and working tree together, so a change that was
  // staged does not survive as a staged change with a clean working tree
  if (tracked.length > 0) {
    const res = await runGit(cwd, [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...tracked
    ])
    if (!res.ok) return fail(gitErrorOf(res))
    discarded.push(...tracked)
  }

  // Unstaging a never-committed file leaves it on disk as untracked, which the
  // clean below then removes — `restore --source=HEAD --worktree` cannot be
  // used on it, since there is no HEAD version to restore from
  if (added.length > 0) {
    const unstage = await runGit(cwd, ['restore', '--staged', '--', ...added])
    if (!unstage.ok) return fail(gitErrorOf(unstage))
    untracked.push(...added)
  }

  // `-f` is the force this file is allowed: deleting an untracked file is what
  // was asked for, and git refuses without it. `-d` covers the collapsed
  // directory rows. Ignored files are never touched — no `-x`, so a discarded
  // folder does not take `.env` or `node_modules` with it.
  if (untracked.length > 0) {
    const res = await runGit(cwd, ['clean', '-f', '-d', '--', ...untracked])
    if (!res.ok) return fail(gitErrorOf(res))
    discarded.push(...untracked)
  }

  return { ok: true, discarded, skipped }
}
