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

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = '/Applications/Chewo.app'

const die = (msg) => {
  console.error(`\n❌ ${msg}\n`)
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
if (spawnSync('pgrep', ['-x', 'Chewo'], { stdio: 'ignore' }).status === 0)
  die('Chewo is running — quit it (⌘Q) and re-run this command.')

console.log(`› Installing ${app} → ${target}`)

const rm = spawnSync('rm', ['-rf', target], { stdio: 'inherit' })
if (rm.status !== 0) die(`Could not remove the existing ${target}.`)

const copy = spawnSync('ditto', [app, target], { stdio: 'inherit' })
if (copy.status !== 0) die(`Could not copy the app into ${target}.`)

console.log('✓ Installed. Open it from /Applications or Spotlight.')
