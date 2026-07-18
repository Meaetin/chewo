import type { SessionMeta, Source } from './adapter/types'

/** A terminal remembered across app restarts — resumable, not live. */
export interface SavedTerminal {
  source: Source
  sessionId: string
  label: string
  /** Set when the terminal runs in an isolated worktree — wake resumes there */
  worktreeId?: string
}

/**
 * Claude's `--permission-mode` values (CC 2.1.x). Both CLIs always start a
 * fresh session at their own default and never remember the mode you flipped
 * to last time — these settings re-apply your choice on every spawn.
 */
export type ClaudePermissionMode =
  | 'manual'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

/** Codex's `--ask-for-approval` policies (codex-cli 0.14x). */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'manual',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions'
]

export const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['untrusted', 'on-request', 'never']

/** How agents launch in a section. Unset = the CLI's own default (asks every time). */
export interface AgentSettings {
  claudeMode?: ClaudePermissionMode
  codexApproval?: CodexApprovalPolicy
}

/** User-created workspace: a named path prefix that sessions auto-assign to. */
export interface Project extends AgentSettings {
  id: string
  name: string
  path: string
  terminals: SavedTerminal[]
  /** Runs visibly in a fresh worktree pane before the agent launches (env copy, install) */
  worktreeSetup?: string
}

/** An isolated git checkout created for one agent task; shares the project's .git. */
export interface Worktree {
  id: string
  projectId: string
  taskName: string
  branch: string
  path: string
  /** Branch the main checkout was on at creation — shown as the merge target */
  baseBranch: string
  createdAt: string
}

/** Top-level app mode, switched from the sidebar's top-left segmented control. */
export type Workflow = 'code' | 'notes'

export interface ProjectsFile {
  projects: Project[]
  selectedProjectId: string | null
  /** Sessions hidden app-wide (projects + search). Files on disk are never touched. */
  hiddenSessionIds: string[]
  /** Remembered terminals of the Home section (terminals with no project) */
  homeTerminals: SavedTerminal[]
  /** Home is a section like any project, so it gets its own launch settings */
  homeSettings: AgentSettings
  worktrees: Worktree[]
  /** Last active workflow — restored on launch */
  workflow?: Workflow
  /** Notes store location; unset = ~/ChewoNotes */
  notesRoot?: string
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = {
  projects: [],
  selectedProjectId: null,
  hiddenSessionIds: [],
  homeTerminals: [],
  homeSettings: {},
  worktrees: []
}

const normalize = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)

/** True when a session's cwd is the project path or lives underneath it. */
export function sessionInProject(sessionProject: string | null, projectPath: string): boolean {
  if (!sessionProject) return false
  const sp = normalize(sessionProject)
  const pp = normalize(projectPath)
  return sp === pp || sp.startsWith(pp + '/')
}

/** Sessions started inside a project's worktrees belong to that project too. */
export function sessionInSection(
  sessionProject: string | null,
  project: Project,
  worktrees: Worktree[]
): boolean {
  if (sessionInProject(sessionProject, project.path)) return true
  return worktrees.some(
    (w) => w.projectId === project.id && sessionInProject(sessionProject, w.path)
  )
}

/**
 * Which project does a session belong to? Worktree paths map to their owning
 * project; otherwise longest matching path wins so a nested project
 * (~/dev/app/packages/x) beats its parent (~/dev/app).
 */
export function assignProject(
  session: SessionMeta,
  projects: Project[],
  worktrees: Worktree[] = []
): Project | null {
  for (const w of worktrees) {
    if (!sessionInProject(session.project, w.path)) continue
    const owner = projects.find((p) => p.id === w.projectId)
    if (owner) return owner
  }
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
