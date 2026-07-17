import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CopyDestination, CopyResult } from '../shared/capabilities/types'

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
