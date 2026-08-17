import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentRef,
  CapabilityInventory,
  CapabilityOrigin,
  FileRef,
  HookRef,
  InstalledPlugin,
  McpRef,
  ProjectTarget,
  SkillRef,
  Tool
} from './types'

/**
 * Read-only scanner over both CLIs' capability surfaces (see
 * SPEC-CAPABILITIES.md §1 for the location matrix). Same discipline as the
 * session adapter: tolerant parsing, skip-don't-crash, injectable roots.
 */

export interface ScanRoots {
  claudeHome?: string // default ~/.claude
  codexHome?: string // default ~/.codex
  claudeConfig?: string // default ~/.claude.json
  /**
   * Installed plugins, already resolved by the caller. Passed in rather than
   * discovered here because finding them means shelling out to `claude plugin
   * list --json`, and this module is pure, synchronous and fixture-testable —
   * the same reason MCP writes live in main rather than in the scanner.
   */
  plugins?: InstalledPlugin[]
}

// ---------- small tolerant parsers ----------

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '')

/**
 * YAML frontmatter subset: `key: value`, folded scalars (`>-`, `|`), and
 * block sequences.
 *
 * Block sequences are collapsed to a comma-joined string rather than widening
 * the return type, so every existing caller keeps working and `splitList`
 * below is the single place that turns any of the three list spellings back
 * into an array. Agent frontmatter needs this: `tools` is usually inline
 * (`tools: Read, Grep`) but `skills` is conventionally written as a block
 * list, and dropping it silently would under-report an agent's real context
 * cost — the exact thing the Agents tab exists to show.
 */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  let key: string | null = null
  let folded = false
  // Only a key introduced with an empty value can collect `- item` lines; a
  // key with an inline value followed by a dash is malformed, not a list.
  let listMode = false
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      const v = kv[2].trim()
      folded = v === '>-' || v === '>' || v === '|' || v === '|-'
      listMode = v === ''
      out[key] = folded ? '' : unquote(v)
      continue
    }
    const item = line.match(/^\s*-\s+(.*\S)\s*$/)
    if (key && listMode && item) {
      const value = unquote(item[1])
      out[key] = out[key] ? `${out[key]}, ${value}` : value
      continue
    }
    if (key && folded && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? out[key] + ' ' : '') + line.trim()
    }
  }
  return out
}

/** `a, b` / `[a, b]` / a collapsed block sequence → `['a', 'b']`. */
export function splitList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(unquote)
    .filter(Boolean)
}

/** `[mcp_servers.<name>]` sections from codex config.toml — name may be quoted.
 *  `[mcp_servers.<name>.env]` sections contribute env KEY NAMES only. */
export function parseCodexMcp(toml: string): McpRef[] {
  const refs = new Map<string, McpRef>()
  let current: McpRef | null = null
  let inEnvOf: McpRef | null = null
  for (const line of toml.split('\n')) {
    const envSection = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\.env\]/)
    if (envSection) {
      inEnvOf = refs.get(envSection[1] ?? envSection[2]) ?? null
      current = null
      continue
    }
    const section = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\]/)
    if (section) {
      const name = section[1] ?? section[2]
      current = { name, tool: 'codex', scope: 'user', command: '', raw: {} }
      refs.set(name, current)
      inEnvOf = null
      continue
    }
    if (/^\[/.test(line)) {
      current = null
      inEnvOf = null
      continue
    }
    if (inEnvOf) {
      const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (key) (inEnvOf.envKeys ??= []).push(key[1])
      continue
    }
    if (!current) continue
    const cmd = line.match(/^command\s*=\s*"(.*)"/)
    if (cmd) {
      current.raw!.command = cmd[1]
      current.command = cmd[1] + (current.command ? ' ' + current.command : '')
    }
    const args = line.match(/^args\s*=\s*\[(.*)\]/)
    if (args) {
      const list = args[1].replace(/"/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      current.raw!.args = list
      const joined = list.join(' ')
      current.command = current.command ? `${current.command} ${joined}` : joined
    }
    const url = line.match(/^url\s*=\s*"(.*)"/)
    if (url) {
      current.raw!.url = url[1]
      if (!current.command) current.command = url[1]
    }
  }
  return [...refs.values()]
}

interface ClaudeMcpEntry {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

function claudeMcpCommand(entry: ClaudeMcpEntry): string {
  if (entry.url) return entry.url
  return [entry.command, ...(entry.args ?? [])].filter(Boolean).join(' ')
}

function claudeMcpRef(name: string, entry: ClaudeMcpEntry, scope: 'user' | 'project'): McpRef {
  return {
    name,
    tool: 'claude',
    scope,
    command: claudeMcpCommand(entry),
    raw: { command: entry.command, args: entry.args, url: entry.url },
    envKeys: entry.env ? Object.keys(entry.env) : undefined // names only, never values
  }
}

// ---------- file helpers ----------

const USER: CapabilityOrigin = { kind: 'user' }
const PROJECT: CapabilityOrigin = { kind: 'project' }

function fileRef(path: string): FileRef | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    const content = readFileSync(path, 'utf8')
    const firstLine = content.split('\n').find((l) => l.trim()) ?? ''
    return { path, bytes: stat.size, firstLine: firstLine.trim().slice(0, 120) }
  } catch {
    return undefined
  }
}

function readSkillsDir(dir: string, tools: Tool[], origin: CapabilityOrigin): SkillRef[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const skills: SkillRef[] = []
  for (const entry of entries) {
    const skillDir = join(dir, entry)
    try {
      const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
      const fm = parseFrontmatter(md)
      skills.push({
        name: fm.name || entry,
        description: fm.description ?? '',
        dir: skillDir,
        tools,
        origin
      })
    } catch {
      /* not a skill dir — skip */
    }
  }
  return skills
}

function readAgentsDir(dir: string, origin: CapabilityOrigin): AgentRef[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const agents: AgentRef[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const path = join(dir, entry)
    try {
      const fm = parseFrontmatter(readFileSync(path, 'utf8'))
      agents.push({
        name: fm.name || entry.replace(/\.md$/, ''),
        description: fm.description ?? '',
        path,
        origin,
        // Absent stays absent: `model` omitted means "inherit", which is not
        // the same claim as any particular model id.
        model: fm.model || undefined,
        effort: fm.effort || undefined,
        color: fm.color || undefined,
        tools: splitList(fm.tools),
        disallowedTools: splitList(fm.disallowedTools),
        skills: splitList(fm.skills)
      })
    } catch {
      /* skip */
    }
  }
  return agents
}

/**
 * Skills and agents shipped by installed plugins.
 *
 * Every plugin here is one the CLI reported at its live version, so the stale
 * copies the cache keeps are never read. Disabled plugins are included and
 * carry `enabled: false` on their origin — they are installed but reach no
 * agent, and hiding them would make that a silent failure. They are filed
 * under Personal · Claude Code regardless of the plugin's install scope: the
 * cache is global, and `plugin list --json` names a scope but not *which*
 * project a project-scoped plugin belongs to, so attributing one to a project
 * would be a guess. The origin badge names the plugin either way.
 */
function readPluginCapabilities(plugins: InstalledPlugin[]): {
  skills: SkillRef[]
  agents: AgentRef[]
} {
  const skills: SkillRef[] = []
  const agents: AgentRef[] = []
  for (const p of plugins) {
    const origin: CapabilityOrigin = {
      kind: 'plugin',
      plugin: p.plugin,
      marketplace: p.marketplace,
      version: p.version,
      enabled: p.enabled
    }
    skills.push(...readSkillsDir(join(p.installPath, 'skills'), ['claude'], origin))
    agents.push(...readAgentsDir(join(p.installPath, 'agents'), origin))
  }
  return { skills, agents }
}

function readClaudeProjectMcp(projectPath: string): McpRef[] {
  try {
    const cfg = JSON.parse(readFileSync(join(projectPath, '.mcp.json'), 'utf8'))
    return Object.entries((cfg.mcpServers ?? {}) as Record<string, ClaudeMcpEntry>).map(
      ([name, entry]) => claudeMcpRef(name, entry, 'project')
    )
  } catch {
    return []
  }
}

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
}

/** Flatten the settings.json `hooks` object into rows — tolerant of shape drift. */
export function parseClaudeHooks(settingsPath: string): HookRef[] {
  let hooksObj: Record<string, HookEntry[]>
  try {
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'))
    hooksObj = cfg.hooks ?? {}
  } catch {
    return []
  }
  const refs: HookRef[] = []
  for (const [event, entries] of Object.entries(hooksObj)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command !== 'string') continue
        refs.push({ event, matcher: entry.matcher || undefined, command: hook.command, settingsPath })
      }
    }
  }
  return refs
}

function readClaudeProjectHooks(projectPath: string): HookRef[] {
  return [
    ...parseClaudeHooks(join(projectPath, '.claude', 'settings.json')),
    ...parseClaudeHooks(join(projectPath, '.claude', 'settings.local.json'))
  ]
}

// ---------- scanners ----------

export function scanCapabilities(
  projects: ProjectTarget[],
  roots: ScanRoots = {}
): CapabilityInventory[] {
  const claudeHome = roots.claudeHome ?? join(homedir(), '.claude')
  const codexHome = roots.codexHome ?? join(homedir(), '.codex')
  const claudeConfig = roots.claudeConfig ?? join(homedir(), '.claude.json')
  const plugin = readPluginCapabilities(roots.plugins ?? [])

  const inventories: CapabilityInventory[] = []

  // Personal · Claude Code
  let claudeUserMcp: McpRef[] = []
  try {
    const cfg = JSON.parse(readFileSync(claudeConfig, 'utf8'))
    claudeUserMcp = Object.entries((cfg.mcpServers ?? {}) as Record<string, ClaudeMcpEntry>).map(
      ([name, entry]) => claudeMcpRef(name, entry, 'user')
    )
  } catch {
    /* no config */
  }
  inventories.push({
    scope: { kind: 'global', tool: 'claude' },
    memory: { claudeMd: fileRef(join(claudeHome, 'CLAUDE.md')) },
    skills: [...readSkillsDir(join(claudeHome, 'skills'), ['claude'], USER), ...plugin.skills],
    agents: [...readAgentsDir(join(claudeHome, 'agents'), USER), ...plugin.agents],
    mcp: claudeUserMcp,
    hooks: parseClaudeHooks(join(claudeHome, 'settings.json'))
  })

  // Personal · Codex
  let codexMcp: McpRef[] = []
  try {
    codexMcp = parseCodexMcp(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    /* no config */
  }
  inventories.push({
    scope: { kind: 'global', tool: 'codex' },
    memory: { agentsMd: fileRef(join(codexHome, 'AGENTS.md')) },
    skills: readSkillsDir(join(codexHome, 'skills'), ['codex'], USER),
    agents: [],
    mcp: codexMcp,
    hooks: [] // Codex hook definitions are plugin-managed, not user config
  })

  // Each project
  for (const p of projects) {
    inventories.push({
      scope: { kind: 'project', projectId: p.id, name: p.name, path: p.path },
      memory: {
        claudeMd: fileRef(join(p.path, 'CLAUDE.md')),
        agentsMd: fileRef(join(p.path, 'AGENTS.md'))
      },
      skills: [
        ...readSkillsDir(join(p.path, '.claude', 'skills'), ['claude'], PROJECT),
        ...readSkillsDir(join(p.path, '.codex', 'skills'), ['codex'], PROJECT),
        ...readSkillsDir(join(p.path, '.agents', 'skills'), ['codex'], PROJECT)
      ],
      agents: readAgentsDir(join(p.path, '.claude', 'agents'), PROJECT),
      mcp: readClaudeProjectMcp(p.path),
      hooks: readClaudeProjectHooks(p.path)
    })
  }

  return inventories
}
