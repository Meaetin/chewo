import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { shell, type BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { loadProjects } from './projects'
import { safeSend } from './safe-send'
import { WORKTREES_ROOT } from './worktrees'

/**
 * Filesystem layer for the file explorer. The renderer sends absolute paths,
 * so every entry point validates that the (symlink-resolved) target lives
 * inside an allowed root: the user's home, the worktrees root, or a known
 * project path. Reads are capped and binary-sniffed — this backs a viewer,
 * not a general fs bridge.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024

/** Directories the tree renders dimmed and never eagerly loads. */
const IGNORED_NAMES = new Set(['.git', 'node_modules'])

export interface DirEntry {
  name: string
  /** Absolute path */
  path: string
  isDir: boolean
  isSymlink: boolean
  isIgnored: boolean
}

export type ReadDirResult = { ok: true; entries: DirEntry[] } | { ok: false; error: string }

export type ReadFileResult =
  | { ok: true; kind: 'text'; content: string; mtimeMs: number }
  | { ok: true; kind: 'image'; dataUrl: string; mtimeMs: number }
  | { ok: false; error: string; reason: 'too-large' | 'binary' | 'not-found' | 'denied' | 'io' }

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif'
}
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function allowedRoots(): string[] {
  const roots = [homedir(), WORKTREES_ROOT, ...loadProjects().projects.map((p) => p.path)]
  return roots.map((r) => {
    try {
      return realpathSync(r)
    } catch {
      return resolve(r)
    }
  })
}

/**
 * Resolve symlinks before checking containment so a link inside a project
 * can't escape the allowed roots. Returns the real path, or null if the
 * target is outside every root.
 */
function resolveInsideRoots(path: string): string | null {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return null
  }
  for (const root of allowedRoots()) {
    if (real === root || real.startsWith(root + sep)) return real
  }
  return null
}

export function readDir(path: string): ReadDirResult {
  const real = resolveInsideRoots(path)
  if (!real) return { ok: false, error: `not readable: ${basename(path)}` }
  try {
    const entries: DirEntry[] = readdirSync(real, { withFileTypes: true }).map((d) => {
      const entryPath = join(real, d.name)
      let isDir = d.isDirectory()
      if (d.isSymbolicLink()) {
        try {
          isDir = statSync(entryPath).isDirectory()
        } catch {
          isDir = false
        }
      }
      return {
        name: d.name,
        path: entryPath,
        isDir,
        isSymlink: d.isSymbolicLink(),
        isIgnored: isDir && IGNORED_NAMES.has(d.name)
      }
    })
    entries.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    )
    return { ok: true, entries }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** True when the path resolves inside an allowed root and is a regular file. */
export function isFile(path: string): boolean {
  const real = resolveInsideRoots(path)
  if (!real) return false
  try {
    return statSync(real).isFile()
  } catch {
    return false
  }
}

export function readFile(path: string): ReadFileResult {
  const real = resolveInsideRoots(path)
  if (!real) {
    let exists = true
    try {
      statSync(path)
    } catch {
      exists = false
    }
    return exists
      ? { ok: false, error: `not readable: ${basename(path)}`, reason: 'denied' }
      : { ok: false, error: 'File not found', reason: 'not-found' }
  }
  try {
    const stat = statSync(real)
    const mime = IMAGE_MIMES[real.split('.').pop()?.toLowerCase() ?? '']
    if (mime) {
      if (stat.size > MAX_IMAGE_BYTES)
        return {
          ok: false,
          error: `Image too large (${Math.round(stat.size / 1024)} KB)`,
          reason: 'too-large'
        }
      const dataUrl = `data:${mime};base64,${readFileSync(real).toString('base64')}`
      return { ok: true, kind: 'image', dataUrl, mtimeMs: stat.mtimeMs }
    }
    if (stat.size > MAX_FILE_BYTES)
      return {
        ok: false,
        error: `File too large (${Math.round(stat.size / 1024)} KB)`,
        reason: 'too-large'
      }
    const buffer = readFileSync(real)
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0))
      return {
        ok: false,
        error: `Binary file (${Math.round(stat.size / 1024)} KB)`,
        reason: 'binary'
      }
    return { ok: true, kind: 'text', content: buffer.toString('utf8'), mtimeMs: stat.mtimeMs }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT'
      ? { ok: false, error: 'File not found', reason: 'not-found' }
      : { ok: false, error: err instanceof Error ? err.message : String(err), reason: 'io' }
  }
}

export type WriteFileResult = { ok: true; mtimeMs: number } | { ok: false; error: string }

/** Only files already opened through readFile are saved — the target exists. */
export function writeFile(path: string, content: string): WriteFileResult {
  const real = resolveInsideRoots(path)
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` }
  try {
    writeFileSync(real, content)
    return { ok: true, mtimeMs: statSync(real).mtimeMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- file operations ----------

export type FileOpResult = { ok: true; path: string } | { ok: false; error: string }

const opFail = (err: unknown): FileOpResult => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err)
})

export function renameEntry(path: string, newName: string): FileOpResult {
  const real = resolveInsideRoots(path)
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` }
  if (!newName || newName === '.' || newName === '..' || /[/\\:\0]/.test(newName))
    return { ok: false, error: 'Invalid name' }
  const target = join(dirname(real), newName)
  if (existsSync(target)) return { ok: false, error: `"${newName}" already exists` }
  try {
    renameSync(real, target)
    return { ok: true, path: target }
  } catch (err) {
    return opFail(err)
  }
}

/** Delete = move to Trash — reversible, agents' repos deserve no less. */
export async function deleteEntry(path: string): Promise<FileOpResult> {
  const real = resolveInsideRoots(path)
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` }
  try {
    await shell.trashItem(real)
    return { ok: true, path: real }
  } catch (err) {
    return opFail(err)
  }
}

/** Finder-style numbered suffix when the name is taken. */
function availableName(destDir: string, name: string): string {
  if (!existsSync(join(destDir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`
    if (!existsSync(join(destDir, candidate))) return candidate
  }
}

export function copyEntry(srcPath: string, destDir: string): FileOpResult {
  const src = resolveInsideRoots(srcPath)
  const dest = resolveInsideRoots(destDir)
  if (!src || !dest) return { ok: false, error: 'not writable' }
  if (dest === src || dest.startsWith(src + sep))
    return { ok: false, error: "Can't copy a folder into itself" }
  try {
    const target = join(dest, availableName(dest, basename(src)))
    cpSync(src, target, { recursive: true })
    return { ok: true, path: target }
  } catch (err) {
    return opFail(err)
  }
}

// ---------- watchers ----------
//
// One watcher per renderer consumer (tree panel, editor), each watching an
// explicit set of paths at depth 0 — expanded dirs report their direct
// children, open files report themselves. Never a recursive root watch:
// the Home section's root is $HOME.

export interface FsChangedEvent {
  watchId: number
  paths: string[]
}

interface WatchEntry {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  pending: Set<string>
}

const watches = new Map<number, WatchEntry>()
let nextWatchId = 1

const DEBOUNCE_MS = 300

export function startWatch(win: BrowserWindow): number {
  const id = nextWatchId++
  const entry: WatchEntry = {
    watcher: chokidar.watch([], { ignoreInitial: true, depth: 0 }),
    timer: null,
    pending: new Set()
  }
  entry.watcher.on('all', (_event, path) => {
    entry.pending.add(path)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      const paths = [...entry.pending]
      entry.pending.clear()
      entry.timer = null
      safeSend(win, 'fs:changed', { watchId: id, paths } satisfies FsChangedEvent)
    }, DEBOUNCE_MS)
  })
  // An unhandled 'error' would throw out of the emitter and take live updates
  // down silently. Log and keep the watcher alive.
  entry.watcher.on('error', (err) => {
    console.error(`file-explorer watch ${id}:`, err)
  })
  watches.set(id, entry)
  return id
}

export function watchAdd(watchId: number, path: string): void {
  const real = resolveInsideRoots(path)
  const entry = watches.get(watchId)
  if (entry && real) entry.watcher.add(real)
}

export function watchRemove(watchId: number, path: string): void {
  const real = resolveInsideRoots(path)
  const entry = watches.get(watchId)
  if (entry && real) void entry.watcher.unwatch(real)
}

export function stopWatch(watchId: number): void {
  const entry = watches.get(watchId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  void entry.watcher.close()
  watches.delete(watchId)
}

export function disposeAllWatches(): void {
  for (const id of [...watches.keys()]) stopWatch(id)
}
