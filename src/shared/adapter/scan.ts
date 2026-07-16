import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseClaudeSession } from './claude'
import { parseCodexSession, parseCodexTitleIndex } from './codex'
import type { ParseResult, ScanResult, SessionMeta, Source } from './types'

export const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')
export const CODEX_ROOT = join(homedir(), '.codex')

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function mergeUnknown(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v
}

function listClaudeFiles(root: string): string[] {
  const files: string[] = []
  for (const projectDir of safeReaddir(root)) {
    const dirPath = join(root, projectDir)
    if (!isDir(dirPath)) continue
    for (const entry of safeReaddir(dirPath)) {
      // Session files live directly in the project dir; subdirectories hold
      // subagent transcripts and memory — not top-level sessions.
      if (entry.endsWith('.jsonl')) files.push(join(dirPath, entry))
    }
  }
  return files
}

function listCodexFiles(root: string): string[] {
  const files: string[] = []
  const sessionsDir = join(root, 'sessions')
  const walk = (dir: string, depth: number): void => {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry)
      if (isDir(p) && depth < 4) walk(p, depth + 1)
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(sessionsDir, 0)
  return files
}

export function scanAll(
  opts: { claudeRoot?: string; codexRoot?: string } = {}
): ScanResult {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT
  const codexRoot = opts.codexRoot ?? CODEX_ROOT

  const sessions: SessionMeta[] = []
  const errors: string[] = []
  const unknownTypes: Record<string, number> = {}

  for (const file of listClaudeFiles(claudeRoot)) {
    try {
      const { meta, stats } = parseClaudeSession(file)
      mergeUnknown(unknownTypes, stats.unknownTypes)
      if (meta.messageCount > 0) sessions.push(meta)
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const titleIndex = parseCodexTitleIndex(join(codexRoot, 'session_index.jsonl'))
  for (const file of listCodexFiles(codexRoot)) {
    try {
      const { meta, stats } = parseCodexSession(file, { titleIndex })
      mergeUnknown(unknownTypes, stats.unknownTypes)
      if (meta.messageCount > 0) sessions.push(meta)
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { sessions, errors, unknownTypes }
}

/**
 * Load a full session (with messages). `filePath` must live under one of the
 * known roots — callers pass paths from renderer-land, so validate.
 */
export function loadSession(
  source: Source,
  filePath: string,
  opts: { claudeRoot?: string; codexRoot?: string } = {}
): ParseResult {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT
  const codexRoot = opts.codexRoot ?? CODEX_ROOT
  const resolved = resolve(filePath)
  const allowed = source === 'claude' ? claudeRoot : codexRoot
  if (!resolved.startsWith(allowed + '/')) {
    throw new Error(`Refusing to read outside session roots: ${resolved}`)
  }
  return source === 'claude'
    ? parseClaudeSession(resolved)
    : parseCodexSession(resolved, {
        titleIndex: parseCodexTitleIndex(join(codexRoot, 'session_index.jsonl'))
      })
}
