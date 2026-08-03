import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { runGit } from './git'
import { safeSend } from './safe-send'

/**
 * "Am I running the latest build?" for the installed app. The build is stamped
 * with the commit it was made from (electron.vite.config.ts define); this
 * module compares that against the repo's current HEAD and pushes the answer
 * to the sidebar footer, re-checking whenever .git/logs/HEAD moves. The Update
 * CTA builds, then hands the bundle swap to a detached install-app.mjs and
 * quits. Dev mode always runs current source, so everything here is a no-op
 * when unpackaged.
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

// install-app.mjs runs after we have quit, so anything that goes wrong in the
// swap has nowhere to report. It leaves the reason here; we read it on the next
// launch and show "Update failed" rather than an unchanged "New version
// available", which is indistinguishable from the button having done nothing.
const errorFile = (): string => join(app.getPath('home'), '.chewo', 'update-error.txt')

function lastUpdateError(): string | null {
  try {
    const message = readFileSync(errorFile(), 'utf8').trim()
    return message || null
  } catch {
    return null
  }
}

const clearUpdateError = (): void => rmSync(errorFile(), { force: true })

export async function getVersionStatus(): Promise<VersionStatus | null> {
  if (!enabled()) return null
  if (updating) return { kind: 'updating' }

  const head = await runGit(__REPO_PATH__, ['rev-parse', 'HEAD'])
  if (!head.ok) return null
  if (head.stdout.trim() === __BUILD_HASH__) {
    // Whatever failed, we are running the build it was trying to install.
    clearUpdateError()
    return { kind: 'current' }
  }

  const failure = lastUpdateError()
  if (failure) return { kind: 'update-failed', message: failure }

  const count = await runGit(__REPO_PATH__, ['rev-list', '--count', `${__BUILD_HASH__}..HEAD`])
  const commits = count.ok ? Number(count.stdout.trim()) : 0
  // Rebase/amend can orphan the build commit — hashes differ but the range is
  // empty; a rebuild still gets you to HEAD, so it counts as one update
  return { kind: 'behind', commits: commits > 0 ? commits : 1 }
}

export function runSelfUpdate(win: BrowserWindow): void {
  if (!enabled() || updating) return
  updating = true
  clearUpdateError()
  safeSend(win, 'version:status', { kind: 'updating' } satisfies VersionStatus)

  // Build only — `dist:install` would end in install-app.mjs, which refuses to
  // replace a running Chewo, and the updater is a running Chewo. Login shell:
  // the packaged app launches with launchd's bare PATH, where npm/node
  // (homebrew, nvm, …) don't resolve.
  execFile(
    '/bin/zsh',
    ['-lc', 'npm run dist'],
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
      installAndRelaunch()
    }
  )
}

/**
 * Hand the bundle swap to a detached helper that waits for us to exit, then
 * reopens the new build. Replacing /Applications/Chewo.app from inside the app
 * it is replacing is the one thing install-app.mjs is written to refuse, so the
 * app leaves first and the copy happens with nothing mounted on it. The helper
 * survives `app.exit` by being detached + unref'd; its output is the only record
 * of a failure after this process is gone, hence the log file.
 */
function installAndRelaunch(): void {
  const log = join(app.getPath('home'), '.chewo', 'update.log')
  mkdirSync(dirname(log), { recursive: true })
  const cmd =
    `node scripts/install-app.mjs --wait-for ${process.pid} --reopen ` +
    `>> ${JSON.stringify(log)} 2>&1`
  const child = spawn('/bin/zsh', ['-lc', cmd], {
    cwd: __REPO_PATH__,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  // No app.relaunch(): the helper opens the *new* bundle once the swap lands,
  // and relaunching here would race it into the old one.
  app.exit(0)
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
