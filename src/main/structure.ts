import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseNote, type NoteStyle } from '../shared/notes'
import { getNotesRoot } from './notes'
import { buildPtyEnv } from './terminals'
import { resolve, sep } from 'node:path'

/**
 * Structuring pass for a dictation that APPENDS to an existing lesson
 * (SPEC-NOTES.md §7, revised): the raw transcript is appended to the
 * lesson's .raw.md twin first (audit trail, survives any failure), then
 * headless Claude structures the new material as a continuation of the
 * lesson's current content. The caller appends the returned body to the
 * lesson — main never writes the lesson file itself, so an open editor
 * can't be clobbered.
 */

export interface StructureArgs {
  /** Absolute path of the lesson .md the dictation belongs to */
  lessonPath: string
  transcript: string
  durationS: number
  sttModel: string
  /** How to read the transcript: lecture material vs meeting discussion. */
  style?: NoteStyle
}

export interface StructureResult {
  ok: boolean
  /** Structured markdown to append to the lesson (ok only) */
  body?: string
  error?: string
}

const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000

const PROMPT = (existingBody: string, transcript: string): string => `You are extending a student's lesson note with newly dictated lecture material.

CURRENT NOTE (markdown, may be empty):
<<<
${existingBody}
>>>

NEW RAW TRANSCRIPT (speech-to-text of the latest recording):
<<<
${transcript}
>>>

Structure the new transcript into markdown that CONTINUES the current note:
- "## " sections grouping the new material by theme, in the order it was taught
- bullet the key points; put key terms in **bold** followed by their definition
- keep the speaker's examples; be faithful to the transcript; never invent content
- do not repeat or rewrite material already in the current note
- no overall summary section, no preamble, no code fences

Output ONLY the new markdown to append.`

const MEETING_PROMPT = (existingBody: string, transcript: string): string => `You are extending a meeting note with the transcript of a newly recorded discussion.

CURRENT NOTE (markdown, may be empty):
<<<
${existingBody}
>>>

NEW RAW TRANSCRIPT (speech-to-text of the latest recording; speakers are not labeled):
<<<
${transcript}
>>>

Structure the new transcript into markdown that CONTINUES the current note:
- "## " sections grouping the discussion by topic, in the order it happened
- bullet the key points; keep who-said-what only when the transcript makes it clear — never guess speakers
- if decisions were made, end with a "## Decisions" section listing each one
- if tasks or follow-ups were agreed, end with a "## Action items" section (checkbox bullets "- [ ] ...", with owner if stated)
- omit the Decisions / Action items sections when the transcript has none; be faithful to the transcript; never invent content
- do not repeat or rewrite material already in the current note
- no overall summary section, no preamble, no code fences

Output ONLY the new markdown to append.`

/** Run `claude -p`; prompt over stdin; resolves to the markdown body. */
function runClaude(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Login shell so PATH matches the user's terminal — same reason the pty
    // terminals use zsh -il. Prompt goes over stdin, never through argv.
    const child = spawn('/bin/zsh', ['-ilc', 'claude -p --model sonnet --output-format json'], {
      cwd,
      env: buildPtyEnv(process.env)
    })
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

function assertLessonInsideRoot(path: string): string {
  const resolved = resolve(path)
  const root = resolve(getNotesRoot())
  if (!resolved.startsWith(root + sep) || !resolved.endsWith('.md'))
    throw new Error(`not a lesson inside the notes root: ${path}`)
  return resolved
}

export async function structureTranscript(args: StructureArgs): Promise<StructureResult> {
  try {
    const lessonPath = assertLessonInsideRoot(args.lessonPath)
    const lessonContent = readFileSync(lessonPath, 'utf8')
    const existingBody = parseNote(lessonContent).body

    // Raw twin: append-only audit trail of every dictation into this lesson
    const rawPath = lessonPath.replace(/\.md$/, '.raw.md')
    const stamp = `*${new Date().toISOString()} — ${Math.round(args.durationS)}s, ${args.sttModel}*`
    const rawChunk = `\n\n---\n\n${stamp}\n\n${args.transcript}\n`
    if (existsSync(rawPath)) {
      appendFileSync(rawPath, rawChunk)
    } else {
      writeFileSync(
        rawPath,
        `---\ntitle: ${basename(lessonPath, '.md')} (raw transcripts)\nstatus: raw\n---\n${rawChunk}`
      )
    }

    const cwd = resolve(lessonPath, '..')
    const prompt = args.style === 'meeting' ? MEETING_PROMPT : PROMPT
    const body = await runClaude(cwd, prompt(existingBody, args.transcript))
    return { ok: true, body }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
