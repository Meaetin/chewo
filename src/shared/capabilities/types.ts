export type Tool = 'claude' | 'codex'

export interface FileRef {
  path: string
  bytes: number
  /** First non-empty content line — cheap preview */
  firstLine: string
}

/**
 * Where a skill or agent definition actually comes from.
 *
 * `plugin` is the one that matters: a plugin's skills and agents live under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, **not** in
 * `~/.claude/skills`, so a scanner reading only the well-known user and
 * project dirs misses every one of them. Measured here 2026-08-17: 4 skills
 * found against 11 actually reachable.
 *
 * Do **not** get that number by walking the cache — it holds stale versions
 * and disabled plugins, and answers 132 for the same machine, off by 12×.
 * Copying is only offered for `user`/`project`: a plugin's files belong to its
 * plugin manager (SPEC-CAPABILITIES §4.4), so they are shown and attachable,
 * never copied.
 */
export type CapabilityOrigin =
  | { kind: 'user' }
  | { kind: 'project' }
  | {
      kind: 'plugin'
      plugin: string
      marketplace: string
      version: string
      /**
       * A disabled plugin's skills and agents are installed but **not visible
       * to any agent**. They are still inventoried, because hiding them turns
       * "why can't my designer agent see the figma skills?" into a silent
       * failure — measured here: figma ships 12 skills and is disabled.
       */
      enabled: boolean
    }

/**
 * One installed plugin, as reported by `claude plugin list --json`.
 *
 * Read via the CLI rather than by globbing the cache because the cache keeps
 * **several versions of the same plugin side by side** (four copies of figma
 * here) and carries disabled ones — only the CLI knows which version is live.
 */
export interface InstalledPlugin {
  /** `<plugin>@<marketplace>`, verbatim from the CLI */
  id: string
  plugin: string
  marketplace: string
  version: string
  /** Root of the installed version; `skills/` and `agents/` hang off it */
  installPath: string
  /** Disabled plugins stay in the cache and stay installed — but reach no agent */
  enabled: boolean
}

export interface SkillRef {
  name: string
  description: string
  dir: string
  /**
   * Size of SKILL.md. Only the one-line `description` normally sits in
   * context — the body is read on demand — so this is not what a skill costs
   * to *have*. It is what it costs to name in a subagent's `skills:`, which
   * preloads the whole body at startup on every invocation.
   */
  bytes: number
  /** Which tool(s) discover it, based on which directory it lives in */
  tools: Tool[]
  origin: CapabilityOrigin
}

/**
 * Claude Code subagent definition (`.claude/agents/*.md`, or a plugin's
 * `agents/`). Codex has subagents too as of codex-cli 0.144.5 (TOML in
 * `~/.codex/agents/`) — not scanned yet; see SPEC-CAPABILITIES §1.
 *
 * The body is deliberately absent: it is the whole system prompt and can run
 * to thousands of lines, and a scan carrying every body across IPC would cost
 * megabytes on a machine with a large agent marketplace installed. The editor
 * reads one on demand through `capabilities:readMemory`.
 */
export interface AgentRef {
  name: string
  description: string
  path: string
  origin: CapabilityOrigin
  /** Frontmatter `model` — absent means `inherit` (the CLI's own default) */
  model?: string
  /** Frontmatter `effort` — absent inherits the session's */
  effort?: string
  /** Frontmatter `color` — display only */
  color?: string
  /** `tools` allowlist; empty means "inherits every tool", not "none" */
  tools: string[]
  /** `disallowedTools` denylist */
  disallowedTools: string[]
  /** `skills` — preloaded in full at startup, so this is a per-run context cost */
  skills: string[]
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
