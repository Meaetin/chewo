import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { safeSend } from './safe-send'

/**
 * Lifecycle for the STT sidecar (SPEC-NOTES.md §6): a headless local process
 * owning mic capture + streaming transcription, speaking JSON-lines over
 * stdio. Spawned lazily on the first recording; the model stays loaded
 * across recordings; killed on app quit. Events are forwarded verbatim to
 * the renderer as 'stt:event'.
 */

let proc: ChildProcessWithoutNullStreams | null = null

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

function ensureSidecar(win: BrowserWindow): ChildProcessWithoutNullStreams | null {
  if (proc && proc.exitCode === null) return proc

  const bin = sidecarPath()
  if (!bin) {
    safeSend(win, 'stt:event', {
      event: 'error',
      message: 'STT sidecar not built — run: npm run build:stt'
    })
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
        safeSend(win, 'stt:event', JSON.parse(line))
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  })
  // WhisperKit logs model download/compile chatter here — not protocol
  child.stderr.on('data', () => {})
  child.on('error', (err) => {
    if (proc === child) proc = null
    safeSend(win, 'stt:event', { event: 'error', message: `STT sidecar failed: ${err.message}` })
  })
  child.on('exit', (code) => {
    if (proc === child) proc = null
    if (code !== 0 && code !== null)
      safeSend(win, 'stt:event', { event: 'error', message: `STT sidecar exited (code ${code})` })
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

export function sttStart(win: BrowserWindow, model: string): void {
  const child = ensureSidecar(win)
  if (child) send(child, { cmd: 'start', model })
}

export function sttStop(): void {
  if (proc) send(proc, { cmd: 'stop' })
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
