import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AgentName = 'claude' | 'codex'

export interface Handoff {
  from: string
  to: AgentName
  note: string
  sessionId?: string
  createdAt: string
}

export const DEFAULT_BRIDGE_ROOT = join(homedir(), '.context-bridge')

function inboxDir(root: string, agent: AgentName): string {
  return join(root, 'inbox', agent)
}

export function writeHandoff(
  handoff: Omit<Handoff, 'createdAt'>,
  root = DEFAULT_BRIDGE_ROOT
): Handoff {
  const full: Handoff = { ...handoff, createdAt: new Date().toISOString() }
  const dir = inboxDir(root, handoff.to)
  mkdirSync(dir, { recursive: true })
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const path = join(dir, filename)
  // Atomic enough for our purposes: single small write, unique name
  appendFileSync(path, JSON.stringify(full, null, 2))
  return full
}

/** Read pending handoffs for `agent`, oldest first, and clear them. */
export function checkInbox(agent: AgentName, root = DEFAULT_BRIDGE_ROOT): Handoff[] {
  const dir = inboxDir(root, agent)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  files.sort()
  const items: Handoff[] = []
  for (const f of files) {
    const path = join(dir, f)
    try {
      items.push(JSON.parse(readFileSync(path, 'utf8')) as Handoff)
      unlinkSync(path)
    } catch {
      /* unreadable handoff — leave it in place rather than destroy evidence */
    }
  }
  return items
}

/** Append-only audit trail of every bridge tool call (spec §4.5). */
export function auditLog(
  agent: string,
  tool: string,
  args: unknown,
  root = DEFAULT_BRIDGE_ROOT
): void {
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(
      join(root, 'audit.log'),
      JSON.stringify({ at: new Date().toISOString(), agent, tool, args }) + '\n'
    )
  } catch {
    /* auditing must never break a tool call */
  }
}
