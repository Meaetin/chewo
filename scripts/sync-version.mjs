// Propagates the root package.json version into the workspace packages.
//
// Runs from the `version` npm lifecycle script, which fires *after* npm bumps
// the root version and *before* it creates the commit and tag — so anything
// staged here lands in that same commit and the tag covers it. That ordering is
// the whole reason this is a `version` script and not a `postversion` one.
//
// Note that semver is not how Chewo identifies a build: `src/main/app-version.ts`
// stamps each build with its git commit and compares that to repo HEAD. This
// version is what shows up in the .app bundle's Get Info panel and in
// electron-builder's artifact filenames.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const version = read(join(root, 'package.json')).version

// Keep in step with the `workspaces` globs in the root package.json.
const workspaces = ['packages/chewo-mcp']

for (const ws of workspaces) {
  const file = join(root, ws, 'package.json')
  const pkg = read(file)
  if (pkg.version === version) {
    console.log(`✓ ${ws} already at ${version}`)
    continue
  }
  pkg.version = version
  // Trailing newline: npm writes package.json this way, so matching it keeps
  // the diff to the one line that actually changed.
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`✓ ${ws} → ${version}`)
}
