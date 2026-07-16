/**
 * Drift canary — parses the REAL ~/.claude and ~/.codex session stores and
 * reports what survived. Run after every CLI update: `npm run canary`.
 * Not a CI test (depends on machine state); this is the early-warning system
 * for schema drift.
 */
import { scanAll } from '../src/shared/adapter'

const { sessions, errors, unknownTypes } = scanAll()

const bySource = { claude: 0, codex: 0 }
for (const s of sessions) bySource[s.source]++

console.log(`parsed ${sessions.length} sessions  (claude: ${bySource.claude}, codex: ${bySource.codex})`)

if (Object.keys(unknownTypes).length) {
  console.log('\nunknown record types (schema drift candidates):')
  for (const [type, count] of Object.entries(unknownTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`)
  }
} else {
  console.log('no unknown record types')
}

if (errors.length) {
  console.log(`\n${errors.length} files failed to parse:`)
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`)
}

console.log('\n5 most recent sessions:')
for (const s of sessions.slice(0, 5)) {
  console.log(`  [${s.source}] ${s.updatedAt}  ${s.title.slice(0, 60)}  (${s.messageCount} msgs)`)
}
