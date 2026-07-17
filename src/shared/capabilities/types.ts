export type Tool = 'claude' | 'codex'

export interface FileRef {
  path: string
  bytes: number
  /** First non-empty content line — cheap preview */
  firstLine: string
}

export interface SkillRef {
  name: string
  description: string
  dir: string
  /** Which tool(s) discover it, based on which directory it lives in */
  tools: Tool[]
}

/** Claude Code subagent definition (.claude/agents/*.md) — CC only */
export interface AgentRef {
  name: string
  description: string
  path: string
}

export interface McpRef {
  name: string
  tool: Tool
  scope: 'user' | 'project'
  /** Human-readable launch string (command+args or URL). Env/secrets never included. */
  command: string
  /** Structured launch info for faithful copying — env VALUES never captured */
  raw?: { command?: string; args?: string[]; url?: string }
  /** Names of env vars the server needs — values must be re-entered manually */
  envKeys?: string[]
}

/** Claude Code hook (settings.json) — a command run automatically on an event */
export interface HookRef {
  /** e.g. PreToolUse, PostToolUse, Stop, Notification */
  event: string
  /** Tool matcher pattern, when the event supports one */
  matcher?: string
  command: string
  /** Which settings file defines it */
  settingsPath: string
}

export type CapabilityScope =
  | { kind: 'global'; tool: Tool }
  | { kind: 'project'; projectId: string; name: string; path: string }

export interface CapabilityInventory {
  scope: CapabilityScope
  memory: { claudeMd?: FileRef; agentsMd?: FileRef }
  skills: SkillRef[]
  agents: AgentRef[]
  mcp: McpRef[]
  /** Claude Code only — Codex hook definitions are plugin-managed */
  hooks: HookRef[]
}

/** Minimal project shape the scanner needs (renderer passes its Project list) */
export interface ProjectTarget {
  id: string
  name: string
  path: string
}

/** Where a copy lands: a project dir or a personal (global) scope, per tool */
export interface CopyDestination {
  kind: 'global' | 'project'
  /** Project path — required when kind is 'project' */
  path?: string
  tool: Tool
  /** Display name for results (project name or "Personal") */
  label: string
}

export interface CopyResult {
  dest: CopyDestination
  status: 'copied' | 'exists' | 'error'
  /** Final on-disk location */
  path: string
  error?: string
}
