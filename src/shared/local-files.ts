/**
 * Which machine-local files follow a project into a fresh worktree.
 *
 * `git worktree add` checks out **tracked files only**, so everything git
 * deliberately ignores is missing from a new session's checkout — `.env` above
 * all. The agent can read and edit immediately, but its first `npm run dev`
 * fails for a reason that has nothing to do with the code. Same shape of
 * problem `cloneNodeModules` solves, different files.
 *
 * Patterns are gitignore-flavoured, because that is the syntax these files are
 * already named in elsewhere: a pattern with no `/` matches by **basename** at
 * any depth (so `.env` finds `apps/web/.env` too), one with a `/` matches the
 * repo-relative path, `*` stops at a path separator and `**` crosses it, and a
 * leading `!` un-matches. Last matching pattern wins, exactly as gitignore
 * resolves it — which is what lets the defaults say "every `.env.*` except the
 * committed examples" in five lines.
 *
 * Nothing here touches the filesystem. The candidate list comes from
 * `git ls-files`, so git's ignore rules decide what counts as machine-local
 * and these decide which of those are wanted.
 */
export const DEFAULT_LOCAL_FILES = [
  '.env',
  '.env.*',
  '!*.example',
  '!*.sample',
  '!*.template'
]

/** One pattern per line; blank lines and `#` comments ignored. Empty = defaults. */
export function parseLocalFilePatterns(text?: string): string[] {
  const lines = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return lines.length > 0 ? lines : DEFAULT_LOCAL_FILES
}

const compiled = new Map<string, RegExp>()

function globToRegExp(glob: string): RegExp {
  const cached = compiled.get(glob)
  if (cached) return cached
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i++
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const re = new RegExp(`^${source}$`)
  compiled.set(glob, re)
  return re
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** `relPath` is repo-relative, with a trailing `/` on directories. */
export function matchesLocalFile(relPath: string, patterns: string[]): boolean {
  const path = relPath.replace(/\/$/, '')
  let wanted = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const glob = (negated ? raw.slice(1) : raw).replace(/\/$/, '')
    if (!glob) continue
    const subject = glob.includes('/') ? path : baseName(path)
    if (globToRegExp(glob).test(subject)) wanted = !negated
  }
  return wanted
}
