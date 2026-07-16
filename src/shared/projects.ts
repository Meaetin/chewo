import type { SessionMeta, Source } from './adapter/types'

/** A terminal remembered across app restarts — resumable, not live. */
export interface SavedTerminal {
  source: Source
  sessionId: string
  label: string
}

/** User-created workspace: a named path prefix that sessions auto-assign to. */
export interface Project {
  id: string
  name: string
  path: string
  terminals: SavedTerminal[]
}

export interface ProjectsFile {
  projects: Project[]
  selectedProjectId: string | null
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = { projects: [], selectedProjectId: null }

const normalize = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)

/** True when a session's cwd is the project path or lives underneath it. */
export function sessionInProject(sessionProject: string | null, projectPath: string): boolean {
  if (!sessionProject) return false
  const sp = normalize(sessionProject)
  const pp = normalize(projectPath)
  return sp === pp || sp.startsWith(pp + '/')
}

/**
 * Which project does a session belong to? Longest matching path wins so a
 * nested project (~/dev/app/packages/x) beats its parent (~/dev/app).
 */
export function assignProject(session: SessionMeta, projects: Project[]): Project | null {
  let best: Project | null = null
  for (const p of projects) {
    if (!sessionInProject(session.project, p.path)) continue
    if (!best || normalize(p.path).length > normalize(best.path).length) best = p
  }
  return best
}

/** Live pane info the session-binding heuristic needs (subset of main's registry). */
export interface UnboundPane {
  termId: number
  source: Source
  cwd: string
  spawnedAtMs: number
}

/**
 * Bind freshly-created session files to panes we spawned without knowing
 * their session id. A session matches a pane when: same source, same cwd,
 * and the session was created after the pane spawned (with clock slop).
 * Oldest matching pane wins so two fresh panes in one cwd bind in order.
 */
export function matchSessionToPane(
  panes: UnboundPane[],
  session: SessionMeta,
  clockSlopMs = 10_000
): UnboundPane | null {
  const createdMs = Date.parse(session.createdAt)
  if (Number.isNaN(createdMs)) return null
  const candidates = panes
    .filter((p) => p.source === session.source)
    .filter((p) => normalize(p.cwd) === normalize(session.project ?? ''))
    .filter((p) => createdMs >= p.spawnedAtMs - clockSlopMs)
    .sort((a, b) => a.spawnedAtMs - b.spawnedAtMs)
  return candidates[0] ?? null
}
