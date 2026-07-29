import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// recordings.ts reaches electron only for app.getPath('userData').
const userData = mkdtempSync(join(tmpdir(), 'chewo-recordings-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const {
  durationOf,
  discardRecording,
  pendingRecordings,
  startRecording,
  wavHeader
} = await import('../src/main/recordings')

/**
 * The safety net's disk half. The Deepgram round trip isn't covered here —
 * what matters is that a survived recording is findable and that the bytes we
 * hand to the batch API are a WAV a decoder will accept.
 */

const SAMPLE_RATE = 16_000
const meta = { model: 'nova-3', language: 'en' }

beforeEach(() => {
  for (const r of pendingRecordings()) discardRecording(r.id)
})

describe('wavHeader', () => {
  test('declares 16 kHz mono 16-bit PCM', () => {
    const header = wavHeader(32_000)
    expect(header).toHaveLength(44)
    expect(header.subarray(0, 4).toString()).toBe('RIFF')
    expect(header.subarray(8, 12).toString()).toBe('WAVE')
    expect(header.subarray(12, 16).toString()).toBe('fmt ')
    expect(header.readUInt16LE(20)).toBe(1) // uncompressed PCM
    expect(header.readUInt16LE(22)).toBe(1) // mono
    expect(header.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(header.readUInt32LE(28)).toBe(SAMPLE_RATE * 2) // byte rate
    expect(header.readUInt16LE(32)).toBe(2) // block align
    expect(header.readUInt16LE(34)).toBe(16) // bits per sample
  })

  test('both length fields track the payload', () => {
    const header = wavHeader(9_600_000)
    expect(header.readUInt32LE(4)).toBe(9_600_000 + 36) // RIFF chunk
    expect(header.subarray(36, 40).toString()).toBe('data')
    expect(header.readUInt32LE(40)).toBe(9_600_000) // data chunk
  })
})

describe('durationOf', () => {
  test('one second of 16 kHz mono Int16 is 32000 bytes', () => {
    expect(durationOf(32_000)).toBe(1)
    expect(durationOf(0)).toBe(0)
    // A two-hour lecture, the case the safety net exists for
    expect(durationOf(2 * 3600 * SAMPLE_RATE * 2)).toBe(7_200)
  })
})

describe('recording lifecycle', () => {
  test('a discarded recording leaves nothing behind', () => {
    const handle = startRecording(meta)
    handle.write(Buffer.alloc(32_000))
    expect(handle.bytes()).toBe(32_000)
    handle.discard()
    expect(pendingRecordings()).toHaveLength(0)
  })

  test('a kept recording becomes recoverable, with its duration and lesson', () => {
    const handle = startRecording({ ...meta, lessonPath: '/notes/physics/waves.md', style: 'lecture' })
    handle.write(Buffer.alloc(SAMPLE_RATE * 2 * 90)) // 90 seconds
    handle.keep()

    const pending = pendingRecordings()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: handle.id,
      durationS: 90,
      lessonPath: '/notes/physics/waves.md',
      model: 'nova-3'
    })
  })

  test('a capture that produced no audio is not offered for recovery', () => {
    // A mic that never opened would otherwise leave a 0-byte row in settings
    startRecording(meta).keep()
    expect(pendingRecordings()).toHaveLength(0)
  })

  test('pending recordings come back newest first', async () => {
    const first = startRecording(meta)
    first.write(Buffer.alloc(32_000))
    first.keep()
    await new Promise((r) => setTimeout(r, 5))
    const second = startRecording(meta)
    second.write(Buffer.alloc(32_000))
    second.keep()

    expect(pendingRecordings().map((r) => r.id)).toEqual([second.id, first.id])
  })

  test('a recording whose audio is gone is not listed', () => {
    const handle = startRecording(meta)
    handle.write(Buffer.alloc(32_000))
    handle.keep()
    rmSync(join(userData, 'recordings', `${handle.id}.pcm`))
    expect(pendingRecordings()).toHaveLength(0)
  })

  test('unreadable metadata is skipped rather than throwing', () => {
    const handle = startRecording(meta)
    handle.write(Buffer.alloc(32_000))
    handle.keep()
    writeFileSync(join(userData, 'recordings', `${handle.id}.json`), 'not json')
    expect(pendingRecordings()).toHaveLength(0)
  })

  test('discardRecording removes both files', () => {
    const handle = startRecording(meta)
    handle.write(Buffer.alloc(32_000))
    handle.keep()
    discardRecording(handle.id)
    expect(existsSync(join(userData, 'recordings', `${handle.id}.pcm`))).toBe(false)
    expect(existsSync(join(userData, 'recordings', `${handle.id}.json`))).toBe(false)
  })

  test('the written PCM is exactly the bytes that were streamed', () => {
    const handle = startRecording(meta)
    const a = Buffer.from([1, 0, 2, 0])
    const b = Buffer.from([3, 0, 4, 0])
    handle.write(a)
    handle.write(b)
    handle.keep()
    const onDisk = readFileSync(join(userData, 'recordings', `${handle.id}.pcm`))
    expect(onDisk).toEqual(Buffer.concat([a, b]))
  })
})
