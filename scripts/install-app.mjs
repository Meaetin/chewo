// Copies the built .app into /Applications. Split out of the `dist:install`
// one-liner so the failure modes explain themselves: electron-builder names its
// output directory after the arch it built for (`mac-arm64` vs `mac`), and a
// hardcoded path just produced a confusing ditto error on anything but this
// machine.
//
// Installing locally is also the *only* friction-free way to run Chewo: the app
// is ad-hoc signed (`identity: null`), so a build that crosses a network
// boundary picks up com.apple.quarantine and macOS refuses it outright. A build
// this machine made and copied itself is never quarantined.
//
// `--wait-for <pid> [--reopen]` is the in-app Update path (main/app-version.ts):
// the running Chewo builds, then leaves this script detached and quits, so the
// swap happens with nothing mounted on the bundle. It is the one caller allowed
// past the "Chewo is running" guard, because it is the thing that stops running.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = '/Applications/Chewo.app'
// Read by main/app-version.ts on the next launch. Everything below this point
// happens after Chewo has quit, so a failure has no window to report into — the
// reopened app would otherwise just show "New version available" again, which
// reads as the button doing nothing.
const errorFile = join(homedir(), '.chewo', 'update-error.txt')

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : process.argv[i + 1]
}
const waitForPid = Number(argOf('--wait-for')) || null
const reopen = process.argv.includes('--reopen')

const die = (msg) => {
  console.error(`\n❌ ${msg}\n`)
  if (waitForPid) {
    try {
      mkdirSync(dirname(errorFile), { recursive: true })
      writeFileSync(errorFile, msg)
    } catch {
      // A missing breadcrumb must not also lose the reopen below.
    }
  }
  // The in-app path already quit Chewo to get here, so a failure that leaves the
  // old bundle intact must still put an app back on screen — otherwise "Update"
  // reads as "quit and never come back".
  if (reopen && existsSync(target)) spawnSync('open', [target], { stdio: 'inherit' })
  process.exit(1)
}

if (process.platform !== 'darwin') die('Chewo is macOS-only.')

if (process.arch !== 'arm64')
  die(
    `Chewo is Apple Silicon only — this is ${process.arch}.\n` +
      '   The node-pty and Electron builds here are not tested on Intel Macs.'
  )

// electron-builder writes `dist/mac-arm64/` on arm64 and `dist/mac/` on x64.
const candidates = ['mac-arm64', 'mac', 'mac-universal'].map((d) => join(root, 'dist', d, 'Chewo.app'))
const app = candidates.find(existsSync)

if (!app)
  die(
    'No built app found in dist/.\n' +
      "   Run `npm run dist` first (or `npm run dist:install`, which does both)."
  )

// ditto onto a running app leaves a half-replaced bundle that crashes on next
// launch, so refuse rather than corrupt it.
//
// `pgrep -x Chewo` cannot be the test: packages/chewo-mcp registers as *this
// binary* under ELECTRON_RUN_AS_NODE, so every MCP server a CLI agent spawns is
// another `MacOS/Chewo` process — owned by that agent, not by us, and alive long
// after the app quits. On this macOS they are in fact the *only* thing `-x`
// matches; the GUI process is not. So the guard blocked every update while
// never once detecting the app it was guarding against.
//
// The app is the bundle's main executable run with no arguments: the MCP servers
// carry the server script as argv[1], and Electron's GPU/utility/renderer
// children live under Frameworks/ and carry `--type=`.
const appProcess = join(target, 'Contents', 'MacOS', 'Chewo')
const chewoRunning = () => {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) return false
  return (ps.stdout || '')
    .split('\n')
    .some((line) => line.trim().replace(/^\d+\s+/, '') === appProcess)
}

if (waitForPid) {
  // Our own parent, on its way out. Wait on the pid first, then on the process
  // table, and give that a grace period rather than one shot: the entry can
  // linger for a moment after the pid stops answering signal 0. Failing on the
  // first read would abort a perfectly good update at random.
  const alive = () => {
    try {
      process.kill(waitForPid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (done, ms) => {
    const deadline = Date.now() + ms
    while (!done() && Date.now() < deadline) await sleep(200)
    return done()
  }
  if (!(await until(() => !alive(), 60_000)))
    die(`Chewo (pid ${waitForPid}) did not quit — nothing was replaced.`)
  // Whatever is left after the grace period is a copy we did not launch.
  if (!(await until(() => !chewoRunning(), 20_000)))
    die('Another Chewo is running — quit it (⌘Q) and update again.')
} else if (chewoRunning()) {
  die('Chewo is running — quit it (⌘Q) and re-run this command.')
}

console.log(`› Installing ${app} → ${target}`)

// Stage the copy beside the target so the slow, failure-prone step happens while
// the installed app is still intact; the swap itself is two renames.
const staged = `${target}.incoming`
const previous = `${target}.previous`
spawnSync('rm', ['-rf', staged, previous], { stdio: 'inherit' })

const copy = spawnSync('ditto', [app, staged], { stdio: 'inherit' })
if (copy.status !== 0) {
  spawnSync('rm', ['-rf', staged], { stdio: 'inherit' })
  die(`Could not copy the app into ${staged}.`)
}

if (existsSync(target) && spawnSync('mv', [target, previous], { stdio: 'inherit' }).status !== 0) {
  spawnSync('rm', ['-rf', staged], { stdio: 'inherit' })
  die(`Could not move the existing ${target} aside.`)
}

if (spawnSync('mv', [staged, target], { stdio: 'inherit' }).status !== 0) {
  if (existsSync(previous)) spawnSync('mv', [previous, target], { stdio: 'inherit' })
  spawnSync('rm', ['-rf', staged], { stdio: 'inherit' })
  die(`Could not move the new build into ${target}.`)
}

spawnSync('rm', ['-rf', previous], { stdio: 'inherit' })

rmSync(errorFile, { force: true })

if (reopen) {
  console.log('✓ Installed. Reopening…')
  spawnSync('open', [target], { stdio: 'inherit' })
} else {
  console.log('✓ Installed. Open it from /Applications or Spotlight.')
}
