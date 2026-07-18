import { spawn } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { kebabCase } from '../shared/notes'
import { getNotesRoot, type NotesOpResult } from './notes'
import { buildPtyEnv } from './terminals'

/**
 * On-stop structuring pass (SPEC-NOTES.md §7): raw transcript → headless
 * Claude → sectioned markdown note. The raw transcript is written first as
 * the note's .raw.md twin and survives regardless of what Claude does; a
 * failed pass leaves a usable raw note behind.
 */

export interface StructureArgs {
  subject: string
  topic: string
  transcript: string
  durationS: number
  sttModel: string
}

const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000

const PROMPT = (rawFileName: string): string => `Read the file "${rawFileName}" in the current directory. After its frontmatter it contains a raw speech-to-text transcript of a lesson.

Produce a structured markdown study note from the transcript:
- "## " sections grouping the material by theme, in the order it was taught
- bullet the key points; put key terms in **bold** followed by their definition
- keep the speaker's examples; be faithful to the transcript; never invent content
- end with a "## Summary" section of 3-5 bullets

Output ONLY the markdown note body — no frontmatter, no preamble, no code fences.`

function frontmatter(
  title: string,
  date: string,
  status: 'raw' | 'structured',
  sttModel: string,
  durationS: number
): string {
  return `---\ntitle: ${title}\ndate: ${date}\nsource: dictation\nstatus: ${status}\nstt: { engine: whisperkit, model: ${sttModel} }\nduration_s: ${Math.round(durationS)}\n---\n\n`
}

/** Run `claude -p` in the topic folder; resolves to the note body markdown. */
function runClaude(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Login shell so PATH matches the user's terminal — same reason the pty
    // terminals use zsh -il. Prompt goes over stdin, never through argv.
    const child = spawn(
      '/bin/zsh',
      ['-ilc', 'claude -p --model sonnet --output-format json --allowedTools Read'],
      { cwd, env: buildPtyEnv(process.env) }
    )
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Structuring timed out after 5 minutes'))
    }, CLAUDE_TIMEOUT_MS)

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean }
        if (parsed.is_error || typeof parsed.result !== 'string')
          throw new Error('claude reported an error result')
        resolvePromise(parsed.result.trim())
      } catch (err) {
        reject(err instanceof SyntaxError ? new Error('Unparseable claude -p output') : err)
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

export async function structureTranscript(args: StructureArgs): Promise<NotesOpResult> {
  try {
    const topicPath = join(getNotesRoot(), args.subject, args.topic)
    if (!statSync(topicPath).isDirectory()) throw new Error('topic folder missing')

    const now = new Date()
    const title = `Lesson ${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`
    const base = `${now.toISOString().slice(0, 10)}-${kebabCase(title)}`
    let suffix = ''
    for (let n = 2; ; n++) {
      try {
        statSync(join(topicPath, `${base}${suffix}.md`))
        suffix = `-${n}`
      } catch {
        break
      }
    }

    const rawPath = join(topicPath, `${base}${suffix}.raw.md`)
    const notePath = join(topicPath, `${base}${suffix}.md`)
    const iso = now.toISOString()

    writeFileSync(
      rawPath,
      frontmatter(title, iso, 'raw', args.sttModel, args.durationS) + args.transcript + '\n'
    )

    try {
      const body = await runClaude(topicPath, PROMPT(`${base}${suffix}.raw.md`))
      writeFileSync(
        notePath,
        frontmatter(title, iso, 'structured', args.sttModel, args.durationS) + body + '\n'
      )
      return { ok: true, path: notePath }
    } catch (err) {
      // .raw.md twins are hidden from page lists, so a failed pass must still
      // yield a visible note — the raw transcript, marked status: raw.
      writeFileSync(
        notePath,
        frontmatter(title, iso, 'raw', args.sttModel, args.durationS) + args.transcript + '\n'
      )
      return {
        ok: false,
        error: String(err instanceof Error ? err.message : err),
        path: notePath
      }
    }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
