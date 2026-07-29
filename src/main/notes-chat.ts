import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { getNotesRoot } from './notes'
import { buildPtyEnv } from './terminals'
import { chatCommand, normalizeChatEvent } from './agent-runner'
import { agentFor } from './settings'
import { safeSend } from './safe-send'

/**
 * Notes Q&A runner (SPEC-NOTES.md §9): the agent chosen in Settings → Agents,
 * run headless with cwd pinned to the scope folder (notes root / subject /
 * topic) and held read-only, so scoping is enforced by the filesystem. Each
 * agent's own event stream is normalized to the ChatEvent contract in
 * `agent-runner` before it reaches the renderer, so the UI stays
 * agent-agnostic. Multi-turn context rides on the agent's resume flag. One
 * chat process at a time.
 */

export interface NotesChatArgs {
  scopePath: string
  message: string
  resumeSessionId?: string
}

const CHAT_TIMEOUT_MS = 5 * 60 * 1000

const FIRST_TURN_PREAMBLE = `You are answering questions about the user's lesson notes — markdown files under the current directory, organized Subject/Topic/lesson.md (each lesson may have a .raw.md transcript twin; prefer the structured lesson). Search the notes to find the relevant lessons before answering, and name the lesson file(s) you drew from. Be concise and answer from the notes; say so plainly when the notes don't cover something.

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

  const choice = agentFor('notesChat')
  // Session ids are UUIDs — safe to inline. The message itself goes via stdin.
  const cmd = chatCommand({
    choice,
    cwd: scope,
    message: args.message,
    resumeSessionId: args.resumeSessionId
  })

  const proc = spawn('/bin/zsh', ['-ilc', cmd], { cwd: scope, env: buildPtyEnv(process.env) })
  child = proc

  const timeout = setTimeout(() => {
    if (child === proc) notesChatCancel()
  }, CHAT_TIMEOUT_MS)

  // A codex turn.failed arrives on stdout *and* exits non-zero; without this
  // the user would see the same failure reported twice.
  let reportedError = false
  let buffer = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // non-JSON chatter (codex prints a banner before its JSONL)
      }
      for (const ev of normalizeChatEvent(choice.agent, raw)) {
        if (ev.type === 'chat_error') reportedError = true
        safeSend(win, 'noteschat:event', ev)
      }
    }
  })
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  proc.on('error', (err) => {
    clearTimeout(timeout)
    if (child === proc) child = null
    reportedError = true
    safeSend(win, 'noteschat:event', { type: 'chat_error', message: err.message })
  })
  proc.on('close', (code) => {
    clearTimeout(timeout)
    if (child === proc) child = null
    if (code !== 0 && code !== null && !reportedError)
      safeSend(win, 'noteschat:event', {
        type: 'chat_error',
        message: `${choice.agent} exited ${code}: ${stderr.slice(0, 200)}`
      })
    safeSend(win, 'noteschat:event', { type: 'chat_closed' })
  })

  proc.stdin.write(args.resumeSessionId ? args.message : FIRST_TURN_PREAMBLE + args.message)
  proc.stdin.end()
}
