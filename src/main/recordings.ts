import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { NoteStyle } from '../shared/notes'
import { STREAM_CHANNELS, STREAM_SAMPLE_RATE, transcribeWav } from './deepgram'

/**
 * The safety net under live transcription (SPEC-NOTES.md §6.3).
 *
 * Every capture is written to disk as raw PCM at the same time it goes onto
 * the wire, because the failure this guards against is a two-hour lecture and
 * a wifi blip forty minutes in: the stream is gone, but the audio isn't.
 * A clean `final` deletes the file; anything else leaves it, and it shows up
 * in Settings → Voice as a pending recovery.
 *
 * ~1.9 MB per minute, so a two-hour lecture is ~230 MB — worth it while the
 * recording is live, which is why the clean path deletes it immediately.
 */

const BYTES_PER_SAMPLE = 2

/**
 * The batch endpoint 504s somewhere past ~10 minutes of audio on Nova models,
 * so recovery submits a sequence of chunks rather than one upload. Five
 * minutes lands each chunk near 9.2 MB.
 *
 * That size is the one number here worth confirming against a real upload:
 * Deepgram's docs give both a 2 GB file ceiling and a 2 MB PAYLOAD_TOO_LARGE
 * error without reconciling them, and 9.2 MB sits between the two.
 */
const CHUNK_SECONDS = 5 * 60
const CHUNK_BYTES = CHUNK_SECONDS * STREAM_SAMPLE_RATE * BYTES_PER_SAMPLE

const recordingsDir = (): string => join(app.getPath('userData'), 'recordings')
const pcmPath = (id: string): string => join(recordingsDir(), `${id}.pcm`)
const metaPath = (id: string): string => join(recordingsDir(), `${id}.json`)

/** What recovery needs to put a transcript back where it belongs. */
export interface RecordingMeta {
  id: string
  startedAt: string
  /** Absent for to-do voice commands — those are too short to be worth saving */
  lessonPath?: string
  style?: NoteStyle
  /** Deepgram model the live stream was using, so a retry matches it */
  model: string
  language: string
}

export interface PendingRecording extends RecordingMeta {
  bytes: number
  durationS: number
}

export function durationOf(bytes: number): number {
  return bytes / BYTES_PER_SAMPLE / STREAM_SAMPLE_RATE / STREAM_CHANNELS
}

export interface RecordingHandle {
  readonly id: string
  write(chunk: Buffer): void
  bytes(): number
  /** Transcription succeeded — the audio has served its purpose. */
  discard(): void
  /** Something failed. Leaves the file for `pendingRecordings()` to find. */
  keep(): void
}

export function startRecording(meta: Omit<RecordingMeta, 'id' | 'startedAt'>): RecordingHandle {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  mkdirSync(recordingsDir(), { recursive: true })
  writeFileSync(
    metaPath(id),
    JSON.stringify({ ...meta, id, startedAt: new Date().toISOString() } satisfies RecordingMeta, null, 2)
  )

  // Synchronous writes, deliberately: a buffered stream loses whatever is
  // still in the buffer when the app dies, and dying mid-recording is exactly
  // the case this file exists for. Each write is ~1600 bytes at ~20/sec, so
  // the cost is microseconds against a durability guarantee.
  let fd: number | null = openSync(pcmPath(id), 'w')
  let written = 0

  const close = (): void => {
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
    fd = null
  }

  const remove = (): void => {
    close()
    for (const path of [pcmPath(id), metaPath(id)]) {
      try {
        if (existsSync(path)) rmSync(path)
      } catch {
        /* a file we can't delete is clutter, not a failure worth surfacing */
      }
    }
  }

  return {
    id,
    write(chunk) {
      if (fd === null) return
      try {
        writeSync(fd, chunk)
        written += chunk.length
      } catch {
        // A full disk shouldn't take the live transcription down with it —
        // the stream is still running and is the primary path.
        close()
      }
    },
    bytes: () => written,
    discard: remove,
    keep() {
      close()
      // An empty capture is nothing to recover — a mic that never opened
      // would otherwise leave a 0-byte entry sitting in the settings pane.
      if (written === 0) remove()
    }
  }
}

/** Recordings whose audio outlived their stream, newest first. */
export function pendingRecordings(): PendingRecording[] {
  const dir = recordingsDir()
  if (!existsSync(dir)) return []
  const out: PendingRecording[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!existsSync(pcmPath(id))) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath(id), 'utf8')) as RecordingMeta
      const bytes = statSync(pcmPath(id)).size
      if (bytes === 0) continue
      out.push({ ...meta, id, bytes, durationS: durationOf(bytes) })
    } catch {
      /* unreadable metadata — nothing useful to offer the user */
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function discardRecording(id: string): void {
  for (const path of [pcmPath(id), metaPath(id)]) {
    try {
      if (existsSync(path)) rmSync(path)
    } catch {
      /* ignore */
    }
  }
}

/**
 * The 44-byte canonical header. Recovery could post raw PCM with
 * `encoding=linear16`, but a WAV is a file the user can also just open and
 * play — which matters when the whole point is that their lecture survived.
 */
export function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = STREAM_SAMPLE_RATE * STREAM_CHANNELS * BYTES_PER_SAMPLE
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM format chunk length
  header.writeUInt16LE(1, 20) // 1 = uncompressed PCM
  header.writeUInt16LE(STREAM_CHANNELS, 22)
  header.writeUInt32LE(STREAM_SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(STREAM_CHANNELS * BYTES_PER_SAMPLE, 32) // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcmBytes, 40)
  return header
}

export interface RecoveryResult {
  ok: boolean
  transcript?: string
  durationS?: number
  meta?: RecordingMeta
  error?: string
}

/**
 * Re-transcribes a survived recording through the pre-recorded API, five
 * minutes at a time, in order.
 *
 * Chunks are read from the file rather than loaded whole: the recording this
 * exists for is the long one, and holding 230 MB of PCM plus its WAV copy in
 * memory to save a few seeks would be a poor trade.
 */
export async function recoverRecording(
  id: string,
  apiKey: string,
  onProgress?: (done: number, total: number) => void
): Promise<RecoveryResult> {
  if (!existsSync(pcmPath(id)) || !existsSync(metaPath(id)))
    return { ok: false, error: 'That recording is no longer on disk.' }

  let meta: RecordingMeta
  try {
    meta = JSON.parse(readFileSync(metaPath(id), 'utf8')) as RecordingMeta
  } catch {
    return { ok: false, error: 'That recording’s details could not be read.' }
  }

  const total = statSync(pcmPath(id)).size
  const chunks = Math.max(1, Math.ceil(total / CHUNK_BYTES))
  const parts: string[] = []
  const fd = openSync(pcmPath(id), 'r')

  try {
    for (let index = 0; index < chunks; index++) {
      const offset = index * CHUNK_BYTES
      const length = Math.min(CHUNK_BYTES, total - offset)
      // Odd byte counts would split a sample in half and shift every sample
      // after it by one byte — white noise rather than speech.
      const aligned = length - (length % BYTES_PER_SAMPLE)
      if (aligned <= 0) continue

      const pcm = Buffer.alloc(aligned)
      readSync(fd, pcm, 0, aligned, offset)

      const text = await transcribeWav(apiKey, Buffer.concat([wavHeader(aligned), pcm]), {
        model: meta.model,
        language: meta.language
      })
      if (text) parts.push(text)
      onProgress?.(index + 1, chunks)
    }
  } catch (error) {
    // Partial recovery is still worth returning — the audio stays on disk, so
    // the user can try the rest again rather than losing what did come back.
    const message = error instanceof Error ? error.message : String(error)
    return parts.length
      ? { ok: true, transcript: parts.join('\n\n'), durationS: durationOf(total), meta }
      : { ok: false, error: `Deepgram rejected the recovery: ${message}` }
  } finally {
    closeSync(fd)
  }

  return { ok: true, transcript: parts.join('\n\n'), durationS: durationOf(total), meta }
}
