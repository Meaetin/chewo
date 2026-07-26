import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parseClaudeSession } from './claude'
import { parseCodexSession, parseCodexTitleIndex } from './codex'
import type { ParseResult, ScanResult, SessionMeta, Source } from './types'

export const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')
export const CODEX_ROOT = join(homedir(), '.codex')

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** A dirent answers this without a syscall; only symlinks still need the stat. */
function isDirEntry(entry: Dirent, path: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
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
    const dirPath = join(root, projectDir.name)
    if (!isDirEntry(projectDir, dirPath)) continue
    for (const entry of safeReaddir(dirPath)) {
      // Session files live directly in the project dir; subdirectories hold
      // subagent transcripts and memory — not top-level sessions.
      if (entry.name.endsWith('.jsonl')) files.push(join(dirPath, entry.name))
    }
  }
  return files
}

function listCodexFiles(root: string): string[] {
  const files: string[] = []
  const sessionsDir = join(root, 'sessions')
  const walk = (dir: string, depth: number): void => {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry.name)
      if (isDirEntry(entry, p)) {
        if (depth < 4) walk(p, depth + 1)
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(p)
      }
    }
  }
  walk(sessionsDir, 0)
  return files
}

// ---------- parse cache ----------
//
// Transcripts are append-only and the store runs to hundreds of megabytes, so
// re-parsing all of them costs well over a second of blocked main thread — and
// the session-store watcher asks for a scan every time any agent writes a line.
// Each scan therefore stats the files (microseconds) and only re-parses the
// ones whose size or mtime moved, which during live work is one file in
// hundreds.

interface CachedMeta {
  mtimeMs: number
  size: number
  meta: SessionMeta
  unknownTypes: Record<string, number>
}

const metaCache = new Map<string, CachedMeta>()

/**
 * Codex titles come from session_index.jsonl rather than the transcript, so a
 * cached codex meta can go stale without its own file changing. Stamp the
 * index and drop the codex half of the cache whenever it moves.
 */
let codexIndexStamp = ''

interface FileStamp {
  mtimeMs: number
  size: number
}

function fileStamp(path: string): FileStamp | null {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

/** Drop cached entries for files that no longer exist under the scanned roots. */
function pruneCache(seen: Set<string>, roots: string[]): void {
  for (const path of metaCache.keys()) {
    if (seen.has(path)) continue
    if (roots.some((root) => path.startsWith(root + sep))) metaCache.delete(path)
  }
}

/** Tests scan throwaway roots; this keeps one case from seeding the next. */
export function resetScanCache(): void {
  metaCache.clear()
  codexIndexStamp = ''
}

export function scanAll(
  opts: { claudeRoot?: string; codexRoot?: string } = {}
): ScanResult {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT
  const codexRoot = opts.codexRoot ?? CODEX_ROOT

  const sessions: SessionMeta[] = []
  const errors: string[] = []
  const unknownTypes: Record<string, number> = {}
  const seen = new Set<string>()

  const indexPath = join(codexRoot, 'session_index.jsonl')
  const indexStat = fileStamp(indexPath)
  const stamp = indexStat ? `${indexStat.mtimeMs}:${indexStat.size}` : ''
  if (stamp !== codexIndexStamp) {
    for (const [path, entry] of metaCache) {
      if (entry.meta.source === 'codex') metaCache.delete(path)
    }
    codexIndexStamp = stamp
  }

  /**
   * Stat first, parse only on a miss. Reading the stamp before parsing means a
   * file appended mid-parse looks changed on the next scan and is re-read —
   * the safe direction to be wrong in.
   */
  const collect = (file: string, parse: () => ParseResult): void => {
    seen.add(file)
    const stat = fileStamp(file)
    if (!stat) return
    let hit = metaCache.get(file)
    if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
      try {
        const { meta, stats } = parse()
        hit = { ...stat, meta, unknownTypes: stats.unknownTypes }
        metaCache.set(file, hit)
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    mergeUnknown(unknownTypes, hit.unknownTypes)
    if (hit.meta.messageCount > 0) sessions.push(hit.meta)
  }

  for (const file of listClaudeFiles(claudeRoot)) {
    collect(file, () => parseClaudeSession(file))
  }

  // Only read when some codex transcript actually misses the cache
  let titleIndex: Map<string, string> | null = null
  for (const file of listCodexFiles(codexRoot)) {
    collect(file, () =>
      parseCodexSession(file, { titleIndex: (titleIndex ??= parseCodexTitleIndex(indexPath)) })
    )
  }

  pruneCache(seen, [claudeRoot, codexRoot])
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
