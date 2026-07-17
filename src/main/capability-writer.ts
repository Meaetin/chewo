import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CopyDestination, CopyResult, HookRef } from '../shared/capabilities/types'

/**
 * The ONLY writer for capabilities (SPEC-CAPABILITIES.md §3). Rules:
 * - copies only — never deletes except replacing a target the user
 *   explicitly confirmed overwriting
 * - collisions return 'exists' instead of writing; caller re-invokes with
 *   overwrite=true after user confirmation
 * - MCP/memory files are NOT handled here (C3/C4)
 */

export interface WriterRoots {
  claudeHome?: string
  codexHome?: string
}

function skillsDirFor(dest: CopyDestination, roots: WriterRoots): string {
  if (dest.kind === 'global') {
    return dest.tool === 'claude'
      ? join(roots.claudeHome ?? join(homedir(), '.claude'), 'skills')
      : join(roots.codexHome ?? join(homedir(), '.codex'), 'skills')
  }
  if (!dest.path) throw new Error('project destination requires a path')
  return join(dest.path, dest.tool === 'claude' ? '.claude' : '.codex', 'skills')
}

function agentsDirFor(dest: CopyDestination, roots: WriterRoots): string {
  if (dest.kind === 'global') return join(roots.claudeHome ?? join(homedir(), '.claude'), 'agents')
  if (!dest.path) throw new Error('project destination requires a path')
  return join(dest.path, '.claude', 'agents')
}

/** Reject names that could escape the target directory */
function safeName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error(`unsafe capability name: ${name}`)
  }
  return name
}

export function copySkill(
  sourceDir: string,
  destinations: CopyDestination[],
  overwrite = false,
  roots: WriterRoots = {}
): CopyResult[] {
  // Validate the source is actually a skill before touching anything
  if (!statSync(sourceDir).isDirectory() || !existsSync(join(sourceDir, 'SKILL.md'))) {
    throw new Error(`not a skill directory (no SKILL.md): ${sourceDir}`)
  }
  readFileSync(join(sourceDir, 'SKILL.md'), 'utf8') // readable check
  const name = safeName(basename(sourceDir))

  return destinations.map((dest) => {
    let targetDir = ''
    try {
      targetDir = join(skillsDirFor(dest, roots), name)
      if (existsSync(targetDir)) {
        if (!overwrite) return { dest, status: 'exists' as const, path: targetDir }
        rmSync(targetDir, { recursive: true, force: true }) // user-confirmed replace
      }
      mkdirSync(join(targetDir, '..'), { recursive: true })
      cpSync(sourceDir, targetDir, { recursive: true })
      return { dest, status: 'copied' as const, path: targetDir }
    } catch (err) {
      return {
        dest,
        status: 'error' as const,
        path: targetDir,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

const MEMORY_FILES = new Set(['CLAUDE.md', 'AGENTS.md'])

function memoryPathFor(dest: CopyDestination, filename: string, roots: WriterRoots): string {
  if (dest.kind === 'project') {
    if (!dest.path) throw new Error('project destination requires a path')
    return join(dest.path, filename)
  }
  // Personal scope: CLAUDE.md lives in ~/.claude, AGENTS.md in ~/.codex
  return filename === 'CLAUDE.md'
    ? join(roots.claudeHome ?? join(homedir(), '.claude'), 'CLAUDE.md')
    : join(roots.codexHome ?? join(homedir(), '.codex'), 'AGENTS.md')
}

/**
 * Duplicate a whole instruction file to scopes that DON'T have one.
 * Deliberately has no overwrite mode — merging/replacing existing memory
 * files is deferred to a diff-preview UX (SPEC-CAPABILITIES.md §2).
 */
export function copyMemoryFile(
  sourcePath: string,
  destinations: CopyDestination[],
  roots: WriterRoots = {}
): CopyResult[] {
  const filename = basename(sourcePath)
  if (!MEMORY_FILES.has(filename)) {
    throw new Error(`not an instruction file (CLAUDE.md/AGENTS.md): ${sourcePath}`)
  }
  const content = readFileSync(sourcePath, 'utf8')

  return destinations.map((dest) => {
    let targetPath = ''
    try {
      targetPath = memoryPathFor(dest, filename, roots)
      if (existsSync(targetPath)) return { dest, status: 'exists' as const, path: targetPath }
      mkdirSync(join(targetPath, '..'), { recursive: true })
      writeFileSync(targetPath, content)
      return { dest, status: 'copied' as const, path: targetPath }
    } catch (err) {
      return {
        dest,
        status: 'error' as const,
        path: targetPath,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

/** Read an instruction file for the viewer — restricted to memory filenames. */
export function readMemoryFile(path: string): string {
  if (!MEMORY_FILES.has(basename(path))) {
    throw new Error(`refusing to read non-instruction file: ${path}`)
  }
  return readFileSync(path, 'utf8')
}

interface HookSettingsEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
}

function hookSettingsPathFor(dest: CopyDestination, roots: WriterRoots): string {
  if (dest.kind === 'global') {
    return join(roots.claudeHome ?? join(homedir(), '.claude'), 'settings.json')
  }
  if (!dest.path) throw new Error('project destination requires a path')
  return join(dest.path, '.claude', 'settings.json')
}

/**
 * Merge one hook (event + matcher + command) into settings.json, preserving
 * everything else in the file. Identical hook already present → 'exists'.
 * Hooks are auto-executing commands: only ever installed via explicit user
 * action in the copy picker, never in bulk with other capability kinds.
 */
export function copyHook(
  ref: HookRef,
  destinations: CopyDestination[],
  roots: WriterRoots = {}
): CopyResult[] {
  if (!ref.event || typeof ref.command !== 'string' || !ref.command.trim()) {
    throw new Error('invalid hook: needs event and command')
  }

  return destinations.map((dest) => {
    let settingsPath = ''
    try {
      settingsPath = hookSettingsPathFor(dest, roots)
      let cfg: { hooks?: Record<string, HookSettingsEntry[]>; [k: string]: unknown } = {}
      if (existsSync(settingsPath)) {
        cfg = JSON.parse(readFileSync(settingsPath, 'utf8'))
      }
      cfg.hooks ??= {}
      const entries = (cfg.hooks[ref.event] ??= [])

      const alreadyThere = entries.some(
        (e) =>
          (e.matcher || undefined) === ref.matcher &&
          (e.hooks ?? []).some((h) => h.command === ref.command)
      )
      if (alreadyThere) return { dest, status: 'exists' as const, path: settingsPath }

      const slot = entries.find((e) => (e.matcher || undefined) === ref.matcher)
      const hook = { type: 'command', command: ref.command }
      if (slot) (slot.hooks ??= []).push(hook)
      else entries.push(ref.matcher ? { matcher: ref.matcher, hooks: [hook] } : { hooks: [hook] })

      mkdirSync(join(settingsPath, '..'), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n')
      return { dest, status: 'copied' as const, path: settingsPath }
    } catch (err) {
      return {
        dest,
        status: 'error' as const,
        path: settingsPath,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

export function copyAgent(
  sourcePath: string,
  destinations: CopyDestination[],
  overwrite = false,
  roots: WriterRoots = {}
): CopyResult[] {
  if (!sourcePath.endsWith('.md') || !statSync(sourcePath).isFile()) {
    throw new Error(`not an agent definition file: ${sourcePath}`)
  }
  const name = safeName(basename(sourcePath))

  return destinations.map((dest) => {
    let targetPath = ''
    try {
      targetPath = join(agentsDirFor(dest, roots), name)
      if (existsSync(targetPath) && !overwrite) {
        return { dest, status: 'exists' as const, path: targetPath }
      }
      mkdirSync(join(targetPath, '..'), { recursive: true })
      cpSync(sourcePath, targetPath)
      return { dest, status: 'copied' as const, path: targetPath }
    } catch (err) {
      return {
        dest,
        status: 'error' as const,
        path: targetPath,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
