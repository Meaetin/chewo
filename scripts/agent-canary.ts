/**
 * Agent-builder canary — third sibling of `canary.ts` (session files) and
 * `chat-canary.ts` (the live chat wire). Run after every CLI update:
 * `npm run canary:agent`.
 *
 * The builder rests on two things the CLI does not promise us:
 *
 *   --json-schema '<json>'      structured output for a *nested* schema — the
 *                               draft carries `skills[]` of objects, which is
 *                               deeper than anything else we ask for
 *   structured_output           where the answer lands in the `-p --output-format
 *                               json` envelope
 *
 * Neither breaks a build or a unit test if it moves, because every other test
 * of this feature feeds `readDraft` a literal. This drives the real binary.
 *
 * It also reports latency, which is the number that decides `TIMEOUT_MS` —
 * measured once at 90s for git text and found to be under the real figure,
 * which made every Ship message a silent fallback.
 *
 * Costs one turn. Writes nothing outside a temp directory.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SCHEMA,
  buildPrompt,
  readDraft,
  type SkillOption
} from '../src/shared/capabilities/agent-draft'
import { serializeAgent } from '../src/shared/capabilities/agent-file'

const TIMEOUT_MS = 180_000

const SKILLS: SkillOption[] = [
  {
    name: 'pdf',
    description: 'Extract text and tables from PDF files',
    origin: 'document-skills plugin',
    installed: true
  },
  {
    name: 'webapp-testing',
    description: 'Drive a web app in a browser and assert on what it renders',
    origin: 'example-skills plugin',
    installed: true
  },
  {
    name: 'not-a-real-skill',
    description: 'Only here to prove unknown names are dropped',
    origin: 'personal',
    installed: true
  }
]

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/bin/zsh', ['-ilc', cmd], { cwd })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    proc.stdout.on('data', (d) => (out += String(d)))
    proc.stderr.on('data', (d) => (err += String(d)))
    proc.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 400)}`))
    })
    proc.stdin.write(
      buildPrompt({
        // Deliberately a request that should reach for a skill *and* a tool
        // policy: a draft that picks nothing leaves the reconciliation
        // assertions below passing vacuously.
        request:
          'An agent that tests a web app in a browser after each change and reports what ' +
          'broke, checking behaviour against the PDF spec documents in the repo. ' +
          'It should read code but never change it.',
        skills: SKILLS,
        existing: [{ name: 'docs-researcher', description: 'Fetches library documentation' }]
      })
    )
    proc.stdin.end()
  })
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'chewo-agent-canary-'))
  const started = Date.now()
  try {
    const stdout = await run(
      `claude -p --model opus --effort high --output-format json --json-schema '${SCHEMA}'`,
      cwd
    )
    const elapsed = Date.now() - started
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>

    const fail: string[] = []
    if (envelope.structured_output === undefined)
      fail.push('no `structured_output` in the -p json envelope (the fallback path would be used)')
    const raw = (envelope.structured_output ?? {}) as Record<string, unknown>
    if (!Array.isArray(raw.skills)) fail.push('`skills` did not come back as an array of objects')

    const draft = readDraft(raw, SKILLS)
    if (!draft.systemPrompt.includes('\n'))
      fail.push('systemPrompt came back as a single line — the schema description is not landing')
    if (draft.skills.some((s) => s.name === 'not-a-real-skill'))
      fail.push('a skill the model was told not to pick survived reconciliation')
    if (draft.skills.some((s) => !s.reason)) fail.push('a chosen skill came back with no reason')
    if (draft.skills.length === 0)
      fail.push('no skills chosen — the reconciliation checks above proved nothing')

    console.log(`\nlatency: ${(elapsed / 1000).toFixed(1)}s (TIMEOUT_MS is ${180_000 / 1000}s)`)
    console.log(`name: ${draft.name}`)
    console.log(`description: ${draft.description}`)
    console.log(`model: ${draft.model ?? 'inherit'}  effort: ${draft.effort ?? 'inherit'}`)
    console.log(`tools: ${draft.tools.join(', ') || '(all)'}`)
    console.log(`disallowed: ${draft.disallowedTools.join(', ') || '(none)'}`)
    console.log(`skills: ${draft.skills.map((s) => `${s.name} — ${s.reason}`).join('\n        ') || '(none)'}`)
    console.log(`\nsystem prompt: ${draft.systemPrompt.length} chars`)
    console.log('--- file as it would be written ---')
    console.log(serializeAgent(draft).slice(0, 700))

    if (fail.length) {
      console.error(`\n✗ ${fail.length} problem(s):`)
      for (const f of fail) console.error(`  - ${f}`)
      process.exit(1)
    }
    console.log('\n✓ agent builder wire format intact')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
