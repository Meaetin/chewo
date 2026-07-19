import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Lifecycle for the STT sidecar (SPEC-NOTES.md §6, SPEC-TODOS.md §6): a
 * headless local process owning mic capture + streaming transcription,
 * speaking JSON-lines over stdio. Spawned lazily; killed on app quit.
 *
 * One capture at a time: notes dictation and todo voice commands both run
 * through here, so a session has an owner and a second caller is rejected
 * (SPEC-TODOS §6 conflict rule). Events route to the owner's sink — the
 * notes renderer or the todo HUD. The model unloads after 15 min idle
 * (~1–1.5 GB resident for large-v3-turbo); `prewarm` loads it mic-less so
 * capture overlap hides the load.
 */

export type SttOwner = 'notes' | 'todo'

export interface SttEventPayload {
  event: string
  rms?: number
  confirmed?: string
  tail?: string
  text?: string
  duration_s?: number
  message?: string
}

type SttSink = (ev: SttEventPayload) => void

const IDLE_UNLOAD_MS = 15 * 60 * 1000

let proc: ChildProcessWithoutNullStreams | null = null
let owner: SttOwner | null = null
let sink: SttSink | null = null
let idleTimer: NodeJS.Timeout | null = null

function sidecarPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'bin', 'chewo-stt-whisper')
    return existsSync(packaged) ? packaged : null
  }
  for (const config of ['release', 'debug']) {
    const built = join(
      app.getAppPath(),
      'packages',
      'stt-whisper',
      '.build',
      config,
      'chewo-stt-whisper'
    )
    if (existsSync(built)) return built
  }
  return null
}

function handleEvent(ev: SttEventPayload): void {
  sink?.(ev)
  // The session ends on final or error — release so the next owner can start
  if (ev.event === 'final' || ev.event === 'error') release()
}

function release(): void {
  owner = null
  sink = null
  startIdleTimer()
}

function startIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!owner && proc) send(proc, { cmd: 'unload' })
  }, IDLE_UNLOAD_MS)
  idleTimer.unref()
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function ensureSidecar(): ChildProcessWithoutNullStreams | null {
  if (proc && proc.exitCode === null) return proc

  const bin = sidecarPath()
  if (!bin) {
    handleEvent({ event: 'error', message: 'STT sidecar not built — run: npm run build:stt' })
    return null
  }

  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        handleEvent(JSON.parse(line) as SttEventPayload)
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  })
  // WhisperKit logs model download/compile chatter here — not protocol
  child.stderr.on('data', () => {})
  child.on('error', (err) => {
    if (proc === child) proc = null
    handleEvent({ event: 'error', message: `STT sidecar failed: ${err.message}` })
  })
  child.on('exit', (code) => {
    if (proc === child) proc = null
    if (code !== 0 && code !== null)
      handleEvent({ event: 'error', message: `STT sidecar exited (code ${code})` })
  })

  proc = child
  return child
}

const send = (child: ChildProcessWithoutNullStreams, cmd: object): void => {
  try {
    child.stdin.write(JSON.stringify(cmd) + '\n')
  } catch {
    /* dying process — exit handler reports it */
  }
}

/** Error string when the mic is owned by the other surface, else null. */
export function sttStart(model: string, who: SttOwner, eventSink: SttSink): string | null {
  if (owner && owner !== who)
    return owner === 'notes' ? 'a notes recording is running' : 'a voice command is running'
  const child = ensureSidecar()
  if (!child) {
    eventSink({ event: 'error', message: 'STT sidecar not built — run: npm run build:stt' })
    return null
  }
  owner = who
  sink = eventSink
  touch()
  send(child, { cmd: 'start', model })
  return null
}

export function sttStop(): void {
  if (proc) send(proc, { cmd: 'stop' })
}

/** Who holds the mic right now — lets the hotkey act as a universal toggle. */
export function sttOwner(): SttOwner | null {
  return owner
}

/** Mic-less model load — capture overlap hides the tail (SPEC-TODOS §6). */
export function sttPrewarm(model: string): void {
  if (!sidecarPath()) return // unbuilt sidecar: stay silent, start() will surface it
  const child = ensureSidecar()
  if (!child) return
  startIdleTimer()
  send(child, { cmd: 'prewarm', model })
}

export function disposeSidecar(): void {
  if (!proc) return
  const child = proc
  proc = null
  send(child, { cmd: 'shutdown' })
  setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, 1500).unref()
}
