import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GENERAL_SCOPE } from './todos'
import { todosRootPath } from './todos-store'

/**
 * Scope index (SPEC-TODOS.md §9): ~/.chewo/todos/scopes.json.
 *
 * Board directories are `p-<slug>-<hash8>` — stable, but they carry no
 * project path, and the project list itself lives in Electron's userData
 * where out-of-process tools can't reach it. So main mirrors the list here,
 * next to the boards it describes, and the context-bridge MCP server reads
 * it to turn a project name — or just the CLI session's cwd — into a scope
 * directory. Stale entries are harmless: they resolve to boards that exist.
 */

export interface TodoScope {
  /** Directory under ~/.chewo/todos */
  dir: string
  /** Human name — "General", or the project's name in Chewo */
  name: string
  /** Absolute project path; absent for General */
  path?: string
}

export interface ScopeIndexFile {
  version: 1
  updatedAt: string
  scopes: TodoScope[]
}

const indexPath = (): string => join(todosRootPath(), 'scopes.json')

export const GENERAL: TodoScope = { dir: GENERAL_SCOPE, name: 'General' }

export function writeScopeIndex(scopes: TodoScope[]): void {
  const file: ScopeIndexFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    scopes: [GENERAL, ...scopes.filter((s) => s.dir !== GENERAL_SCOPE)]
  }
  writeFileSync(indexPath(), JSON.stringify(file, null, 2))
}

export function readScopeIndex(): TodoScope[] {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), 'utf8')) as ScopeIndexFile
    const scopes = (parsed.scopes ?? []).filter((s) => typeof s?.dir === 'string')
    return scopes.some((s) => s.dir === GENERAL_SCOPE) ? scopes : [GENERAL, ...scopes]
  } catch {
    // No index yet (app never launched since T3, or ~/.chewo wiped) — the
    // General board still works, project boards need the app to write one
    return [GENERAL]
  }
}

const norm = (s: string): string => s.trim().toLowerCase()

/**
 * Symlinks must not split a project in two: a CLI's `process.cwd()` is
 * already resolved (/private/var/…) while the path Chewo recorded may not be
 * (/var/…), and the raw strings would never match.
 */
const real = (path: string): string => {
  try {
    return realpathSync(path).replace(/\/$/, '')
  } catch {
    return path.replace(/\/$/, '')
  }
}

/** Deepest project whose directory contains `cwd` — subdirectories of a
 * project resolve to that project's board, and nested projects win. */
export function scopeForPath(scopes: TodoScope[], cwd: string): TodoScope | null {
  const from = real(cwd)
  let best: TodoScope | null = null
  let bestLength = 0
  for (const scope of scopes) {
    if (!scope.path) continue
    const dir = real(scope.path)
    if (from !== dir && !from.startsWith(dir + '/')) continue
    if (!best || dir.length > bestLength) {
      best = scope
      bestLength = dir.length
    }
  }
  return best
}

/**
 * Resolve a caller-supplied scope: a directory name, a project name (as the
 * user says it), or a project path. Unnamed → the project owning `cwd`,
 * falling back to General (§8). Returns null when a named scope matches
 * nothing, so the caller can list the valid ones instead of guessing.
 */
export function resolveScope(
  scopes: TodoScope[],
  query: string | undefined,
  cwd?: string
): TodoScope | null {
  if (!query?.trim()) {
    return (cwd ? scopeForPath(scopes, cwd) : null) ?? GENERAL
  }
  const q = norm(query)
  return (
    scopes.find((s) => norm(s.dir) === q) ??
    scopes.find((s) => norm(s.name) === q) ??
    scopes.find((s) => s.path && norm(s.path) === q) ??
    scopes.find((s) => norm(s.name).replace(/[^a-z0-9]/g, '') === q.replace(/[^a-z0-9]/g, '')) ??
    null
  )
}
