import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { getNotesRoot } from './notes'
import { buildPtyEnv } from './terminals'
import { safeSend } from './safe-send'

/**
 * Notes Q&A runner (SPEC-NOTES.md §9): headless Claude with cwd pinned to
 * the scope folder (notes root / subject / topic) and read-only tools, so
 * scoping is enforced by the filesystem. stream-json lines are forwarded
 * verbatim to the renderer as 'noteschat:event'; multi-turn context rides on
 * --resume. One chat process at a time.
 */

export interface NotesChatArgs {
  scopePath: string
  message: string
  resumeSessionId?: string
}

const CHAT_TIMEOUT_MS = 5 * 60 * 1000

const FIRST_TURN_PREAMBLE = `You are answering questions about the user's lesson notes — markdown files under the current directory, organized Subject/Topic/lesson.md (each lesson may have a .raw.md transcript twin; prefer the structured lesson). Use Glob/Grep/Read to find the relevant lessons before answering, and name the lesson file(s) you drew from. Be concise and answer from the notes; say so plainly when the notes don't cover something.

Question: `

let child: ChildProcessWithoutNullStreams | null = null

export function notesChatCancel(): void {
  if (!child) return
  const proc = child
  child = null
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
}

export function notesChatSend(win: BrowserWindow, args: NotesChatArgs): void {
  notesChatCancel()

  let scope: string
  try {
    scope = resolve(args.scopePath)
    const root = resolve(getNotesRoot())
    if (scope !== root && !scope.startsWith(root + sep))
      throw new Error('scope outside the notes root')
    if (!statSync(scope).isDirectory()) throw new Error('scope folder missing')
  } catch (err) {
    safeSend(win, 'noteschat:event', {
      type: 'chat_error',
      message: String(err instanceof Error ? err.message : err)
    })
    return
  }

  // Session ids are UUIDs — safe to inline. The message itself goes via stdin.
  const resumeArg = args.resumeSessionId ? ` --resume ${args.resumeSessionId}` : ''
  // allowedTools only pre-approves — the user's global permission allowlist
  // could still let Bash/Write through, so scope-breaking tools are denied
  // explicitly. Q&A must stay read-only inside the scope folder.
  const cmd =
    'claude -p --model sonnet --output-format stream-json --verbose' +
    ' --allowedTools "Read,Grep,Glob"' +
    ' --disallowedTools "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch"' +
    resumeArg

  const proc = spawn('/bin/zsh', ['-ilc', cmd], { cwd: scope, env: buildPtyEnv(process.env) })
  child = proc

  const timeout = setTimeout(() => {
    if (child === proc) notesChatCancel()
  }, CHAT_TIMEOUT_MS)

  let buffer = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        safeSend(win, 'noteschat:event', JSON.parse(line))
      } catch {
        /* non-JSON chatter */
      }
    }
  })
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  proc.on('error', (err) => {
    clearTimeout(timeout)
    if (child === proc) child = null
    safeSend(win, 'noteschat:event', { type: 'chat_error', message: err.message })
  })
  proc.on('close', (code) => {
    clearTimeout(timeout)
    if (child === proc) child = null
    if (code !== 0 && code !== null)
      safeSend(win, 'noteschat:event', {
        type: 'chat_error',
        message: `claude exited ${code}: ${stderr.slice(0, 200)}`
      })
    safeSend(win, 'noteschat:event', { type: 'chat_closed' })
  })

  proc.stdin.write(args.resumeSessionId ? args.message : FIRST_TURN_PREAMBLE + args.message)
  proc.stdin.end()
}
