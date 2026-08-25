import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import type { NoteStyle, SttOwner, SttSource } from '../shared/notes'
import { normalizeStt } from '../shared/stt'
import { deepgramKey } from './credentials'
import { openDeepgramStream, type DeepgramStream } from './deepgram'
import { durationOf, startRecording, type RecordingHandle } from './recordings'
import { loadSettings } from './settings'

/**
 * Dictation orchestration (SPEC-NOTES.md §6, SPEC-TODOS.md §6).
 *
 * Two halves meet here. The Swift sidecar is a pure capture process — it opens
 * the mic or a Core Audio process tap and writes 16 kHz mono Int16 to fd 3,
 * and knows nothing about transcription. This file owns the Deepgram
 * connection, so the API key never leaves the main process and swapping
 * providers is a TypeScript edit rather than a Swift rebuild.
 *
 * One capture at a time: notes dictation and to-do voice commands both run
 * through here, so a session has an owner and a second caller is rejected
 * (SPEC-TODOS §6 conflict rule). Events route to the owner's sink — the notes
 * renderer or the to-do HUD.
 *
 * Every byte that goes onto the wire is also written to disk (recordings.ts).
 * A clean finish deletes it; a dropped connection leaves it recoverable.
 */

export type { SttOwner }

export interface SttEventPayload {
  event: string
  /** Filled in by `emit` — every event says which surface it belongs to */
  owner?: SttOwner
  rms?: number
  confirmed?: string
  tail?: string
  text?: string
  duration_s?: number
  message?: string
}

type SttSink = (ev: SttEventPayload) => void

/** Where a recovered transcript belongs, persisted alongside the audio. */
export interface SttContext {
  lessonPath?: string
  style?: NoteStyle
}

/**
 * The sidecar drains its write queue before emitting `stopped`, so the last
 * PCM is already in the fd-3 pipe by then — but Node may not have surfaced it
 * as `data` yet. Wait for the pipe to go quiet before closing the stream,
 * rather than clipping the final words off every recording.
 */
const AUDIO_QUIET_MS = 100
const AUDIO_DRAIN_CAP_MS = 1_000

let proc: ChildProcess | null = null
let owner: SttOwner | null = null
let sink: SttSink | null = null
let stream: DeepgramStream | null = null
let recording: RecordingHandle | null = null
let lastAudioAt = 0
let broadcast: SttSink = () => {}

/** Where ownerless events go — recovery progress and status changes. */
export function setSttBroadcast(fn: SttSink): void {
  broadcast = fn
}

function sidecarPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'bin', 'chewo-audio-capture')
    return existsSync(packaged) ? packaged : null
  }
  for (const config of ['release', 'debug']) {
    const built = join(
      app.getAppPath(),
      'packages',
      'audio-capture',
      '.build',
      config,
      'chewo-audio-capture'
    )
    if (existsSync(built)) return built
  }
  return null
}

function emit(ev: SttEventPayload): void {
  // Tagged here rather than at each call site: one window listens for all
  // three surfaces on one channel, so an untagged event is one the renderer
  // has to guess the owner of — and it guesses "notes", which is where a chat
  // dictation's words would then land.
  if (sink) sink(owner ? { ...ev, owner } : ev)
  else broadcast(ev)
}

/** Ends the session, keeping or discarding the audio depending on outcome. */
function release(keepAudio: boolean): void {
  if (recording) {
    if (keepAudio) recording.keep()
    else recording.discard()
    recording = null
  }
  stream = null
  owner = null
  sink = null
}

function ensureSidecar(): ChildProcess | null {
  if (proc && proc.exitCode === null) return proc

  const bin = sidecarPath()
  if (!bin) return null

  // The fourth pipe is the audio channel — stdout stays a clean JSON-lines
  // control channel, so a burst of PCM can never be mistaken for an event.
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })

  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        handleSidecarEvent(JSON.parse(line) as SttEventPayload)
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  })

  const audio = child.stdio[3] as Readable | undefined
  audio?.on('data', (chunk: Buffer) => {
    lastAudioAt = Date.now()
    recording?.write(chunk)
    stream?.send(chunk)
  })

  child.stderr?.on('data', () => {})
  child.on('error', (err) => {
    if (proc === child) proc = null
    fail(`Audio capture failed: ${err.message}`)
  })
  child.on('exit', (code) => {
    if (proc === child) proc = null
    if (code !== 0 && code !== null) fail(`Audio capture exited (code ${code})`)
  })

  proc = child
  return child
}

/** Terminal error: report it, and keep whatever audio was captured. */
function fail(message: string): void {
  // No session to end — a sidecar-level complaint (a missing fd 3, a crash
  // between captures). Still worth surfacing rather than swallowing.
  if (!owner) {
    broadcast({ event: 'error', message })
    return
  }
  const hadAudio = (recording?.bytes() ?? 0) > 0
  stream?.abort()
  emit({
    event: 'error',
    message: hadAudio
      ? `${message} — the audio was saved, recover it in Settings → Voice.`
      : message
  })
  release(true)
}

function handleSidecarEvent(ev: SttEventPayload): void {
  switch (ev.event) {
    case 'ready':
      emit({ event: 'ready' })
      break
    case 'level':
      emit(ev)
      break
    case 'stopped':
      void finalize()
      break
    case 'error':
      fail(ev.message ?? 'Audio capture error')
      break
  }
}

/** Waits for the fd-3 pipe to go quiet, so no captured audio is left unsent. */
async function drainAudio(): Promise<void> {
  const deadline = Date.now() + AUDIO_DRAIN_CAP_MS
  while (Date.now() < deadline && Date.now() - lastAudioAt < AUDIO_QUIET_MS) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function finalize(): Promise<void> {
  if (!owner) return
  const active = stream
  const handle = recording

  if (!active) {
    // A stop that arrived before the stream ever opened still has to resolve
    // the session, or the UI waits on a `final` that never comes.
    emit({ event: 'final', text: '', duration_s: 0 })
    release(false)
    return
  }

  await drainAudio()
  const durationS = durationOf(handle?.bytes() ?? 0)
  let text: string
  try {
    text = await active.finish()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return
  }
  emit({ event: 'final', text, duration_s: durationS })
  // The transcript is out, so the audio has done its job. The one case worth
  // keeping is real audio that came back with no words — that is a Deepgram
  // problem rather than a silent room, and it is recoverable.
  release(text === '' && durationS > 2)
}

const send = (child: ChildProcess, cmd: object): void => {
  try {
    child.stdin?.write(JSON.stringify(cmd) + '\n')
  } catch {
    /* dying process — exit handler reports it */
  }
}

/** Why the mic can't be had — named by whoever already has it. */
const BUSY: Record<SttOwner, string> = {
  notes: 'Mic is busy — a notes recording is running.',
  todo: 'Mic is busy — a voice command is running.',
  chat: 'Mic is busy — a chat is being dictated into.'
}

const NO_KEY = 'Add a Deepgram API key in Settings → Voice to turn on dictation.'
const NO_SIDECAR = 'Audio capture isn’t built — run: npm run build:stt'

/** A ready-to-show sentence when the mic can't be opened, else null. */
export function sttStart(
  who: SttOwner,
  eventSink: SttSink,
  source: SttSource = 'mic',
  context: SttContext = {}
): string | null {
  if (owner && owner !== who) return BUSY[owner]

  // Same shape as the old "model isn't downloaded" gate: refuse with a
  // sentence rather than opening a mic that has nowhere to send audio.
  const key = deepgramKey()
  if (!key) return NO_KEY

  const child = ensureSidecar()
  if (!child) return NO_SIDECAR

  owner = who
  sink = eventSink
  emit({ event: 'connecting' })

  const stt = normalizeStt(loadSettings().stt)
  void openDeepgramStream({
    apiKey: key,
    model: stt.model,
    language: stt.language,
    keyterms: stt.keyterms,
    onPartial: ({ confirmed, tail }) => emit({ event: 'partial', confirmed, tail }),
    onError: (message) => fail(`Deepgram: ${message}`)
  })
    .then((opened) => {
      // A stop during the connect handshake released the session already —
      // don't open a mic the user has walked away from.
      if (owner !== who) {
        opened.abort()
        return
      }
      stream = opened
      recording = startRecording({
        lessonPath: context.lessonPath,
        style: context.style,
        model: stt.model,
        language: stt.language
      })
      lastAudioAt = Date.now()
      // Capture starts only once the wire is up, so the sidecar never
      // produces audio before there is somewhere to send it.
      send(child, { cmd: 'start', source })
    })
    .catch((error: unknown) => {
      if (owner !== who) return
      const message = error instanceof Error ? error.message : String(error)
      emit({ event: 'error', message: `Could not reach Deepgram: ${message}` })
      release(false)
    })

  return null
}

export function sttStop(): void {
  if (!owner) return
  // Capture running: the sidecar answers with `stopped` once it has drained.
  if (recording) {
    if (proc) send(proc, { cmd: 'stop' })
    // The sidecar died under us, so no `stopped` is coming — finish with
    // whatever Deepgram already returned rather than hanging on Stop.
    else void finalize()
    return
  }
  // Stop landed during the connect handshake — nothing will emit `stopped`,
  // so resolve the session here instead of leaving the UI on "Connecting…".
  stream?.abort()
  emit({ event: 'final', text: '', duration_s: 0 })
  release(false)
}

/** Who holds the mic right now — lets the hotkey act as a universal toggle. */
export function sttOwner(): SttOwner | null {
  return owner
}

export function disposeSidecar(): void {
  // Quitting mid-recording is exactly when the audio matters: keep it.
  stream?.abort()
  recording?.keep()
  recording = null
  stream = null
  owner = null
  sink = null
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
