import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { runGit } from './git'
import { safeSend } from './safe-send'

/**
 * "Am I running the latest build?" for the installed app. The build is stamped
 * with the commit it was made from (electron.vite.config.ts define); this
 * module compares that against the repo's current HEAD and pushes the answer
 * to the sidebar footer, re-checking whenever .git/logs/HEAD moves. The
 * Update CTA rebuilds and reinstalls via `npm run dist:install`, then
 * relaunches. Dev mode always runs current source, so everything here is a
 * no-op when unpackaged.
 */

// Injected at build time — see electron.vite.config.ts
declare const __BUILD_HASH__: string
declare const __REPO_PATH__: string

export type VersionStatus =
  | { kind: 'current' }
  | { kind: 'behind'; commits: number }
  | { kind: 'updating' }
  | { kind: 'update-failed'; message: string }

const enabled = (): boolean =>
  app.isPackaged && __BUILD_HASH__ !== '' && existsSync(join(__REPO_PATH__, '.git'))

let updating = false

export async function getVersionStatus(): Promise<VersionStatus | null> {
  if (!enabled()) return null
  if (updating) return { kind: 'updating' }

  const head = await runGit(__REPO_PATH__, ['rev-parse', 'HEAD'])
  if (!head.ok) return null
  if (head.stdout.trim() === __BUILD_HASH__) return { kind: 'current' }

  const count = await runGit(__REPO_PATH__, ['rev-list', '--count', `${__BUILD_HASH__}..HEAD`])
  const commits = count.ok ? Number(count.stdout.trim()) : 0
  // Rebase/amend can orphan the build commit — hashes differ but the range is
  // empty; a rebuild still gets you to HEAD, so it counts as one update
  return { kind: 'behind', commits: commits > 0 ? commits : 1 }
}

export function runSelfUpdate(win: BrowserWindow): void {
  if (!enabled() || updating) return
  updating = true
  safeSend(win, 'version:status', { kind: 'updating' } satisfies VersionStatus)

  // Login shell: the packaged app launches with launchd's bare PATH, where
  // npm/node (homebrew, nvm, …) don't resolve
  execFile(
    '/bin/zsh',
    ['-lc', 'npm run dist:install'],
    { cwd: __REPO_PATH__, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      updating = false
      if (err) {
        const tail = (String(stderr).trim() || String(stdout).trim() || err.message)
          .split('\n')
          .slice(-4)
          .join('\n')
        safeSend(win, 'version:status', {
          kind: 'update-failed',
          message: tail
        } satisfies VersionStatus)
        return
      }
      // The .app in /Applications was just replaced under us; the running
      // process keeps its mapped binary, so relaunch picks up the new one
      app.relaunch()
      app.exit(0)
    }
  )
}

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

export function watchRepoHead(win: BrowserWindow): void {
  if (!enabled() || watcher) return
  // logs/HEAD is appended on every commit, checkout and reset — exactly the
  // moments the answer can change
  watcher = chokidar.watch(join(__REPO_PATH__, '.git', 'logs', 'HEAD'), { ignoreInitial: true })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void getVersionStatus().then((status) => {
        if (status) safeSend(win, 'version:status', status)
      })
    }, 500)
  })
}

export function disposeVersionWatch(): void {
  if (timer) clearTimeout(timer)
  timer = null
  void watcher?.close()
  watcher = null
}
