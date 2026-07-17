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
}

/** Minimal project shape the scanner needs (renderer passes its Project list) */
export interface ProjectTarget {
  id: string
  name: string
  path: string
}
