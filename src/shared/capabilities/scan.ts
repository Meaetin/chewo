import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentRef,
  CapabilityInventory,
  FileRef,
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
}

// ---------- small tolerant parsers ----------

/** YAML frontmatter subset: `key: value` plus folded scalars (>-, |). */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  let key: string | null = null
  let folded = false
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      const v = kv[2].trim()
      if (v === '>-' || v === '>' || v === '|' || v === '|-') {
        out[key] = ''
        folded = true
      } else {
        out[key] = v.replace(/^['"]|['"]$/g, '')
        folded = false
      }
    } else if (key && folded && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? out[key] + ' ' : '') + line.trim()
    }
  }
  return out
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

function readSkillsDir(dir: string, tools: Tool[]): SkillRef[] {
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
        tools
      })
    } catch {
      /* not a skill dir — skip */
    }
  }
  return skills
}

function readAgentsDir(dir: string): AgentRef[] {
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
        path
      })
    } catch {
      /* skip */
    }
  }
  return agents
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

// ---------- scanners ----------

export function scanCapabilities(
  projects: ProjectTarget[],
  roots: ScanRoots = {}
): CapabilityInventory[] {
  const claudeHome = roots.claudeHome ?? join(homedir(), '.claude')
  const codexHome = roots.codexHome ?? join(homedir(), '.codex')
  const claudeConfig = roots.claudeConfig ?? join(homedir(), '.claude.json')

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
    skills: readSkillsDir(join(claudeHome, 'skills'), ['claude']),
    agents: readAgentsDir(join(claudeHome, 'agents')),
    mcp: claudeUserMcp
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
    skills: readSkillsDir(join(codexHome, 'skills'), ['codex']),
    agents: [],
    mcp: codexMcp
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
        ...readSkillsDir(join(p.path, '.claude', 'skills'), ['claude']),
        ...readSkillsDir(join(p.path, '.codex', 'skills'), ['codex']),
        ...readSkillsDir(join(p.path, '.agents', 'skills'), ['codex'])
      ],
      agents: readAgentsDir(join(p.path, '.claude', 'agents')),
      mcp: readClaudeProjectMcp(p.path)
    })
  }

  return inventories
}
