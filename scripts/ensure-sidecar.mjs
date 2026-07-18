// Builds the STT sidecar only when its sources are newer than the last build
// product (or it's missing). Wired into `predev` and `predist` so `npm run dev`
// and `npm run dist:install` always have a sidecar without a slow rebuild every
// time. Pass --soft to warn-and-continue on failure (dev), else it exits non-
// zero so a release build fails loudly rather than shipping a broken app.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const soft = process.argv.includes('--soft')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'packages', 'stt-whisper')
const binary = join(pkgDir, '.build', 'release', 'chewo-stt-whisper')

const fail = (msg) => {
  if (soft) {
    console.warn(`\n⚠️  ${msg}\n   STT dictation will be unavailable until the sidecar builds.\n`)
    process.exit(0)
  }
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

/** Newest mtime among the Swift sources + manifests that affect the build. */
function newestSourceMtime() {
  const roots = [join(pkgDir, 'Sources')]
  for (const f of ['Package.swift', 'Package.resolved']) {
    const p = join(pkgDir, f)
    if (existsSync(p)) roots.push(p)
  }
  let newest = 0
  const walk = (p) => {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name))
    } else {
      newest = Math.max(newest, st.mtimeMs)
    }
  }
  for (const r of roots) if (existsSync(r)) walk(r)
  return newest
}

if (existsSync(binary) && statSync(binary).mtimeMs >= newestSourceMtime()) {
  console.log('✓ STT sidecar up to date')
  process.exit(0)
}

// Fail fast with a clear message if the Swift toolchain isn't installed
if (spawnSync('swift', ['--version'], { stdio: 'ignore' }).status !== 0)
  fail('Swift toolchain not found — install Xcode / the Swift toolchain to build the STT sidecar.')

console.log('› Building STT sidecar (first build downloads WhisperKit — this can take a few minutes)…')
const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', pkgDir], {
  stdio: 'inherit'
})
if (build.status !== 0) fail('STT sidecar build failed.')
console.log('✓ STT sidecar built')
