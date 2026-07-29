import { DeepgramClient } from '@deepgram/sdk'

/**
 * The only file that talks to Deepgram (SPEC-NOTES.md §6).
 *
 * The connection lives in main, not the renderer, for two reasons: the API key
 * never has to cross into a browser context, and the streaming handshake
 * authenticates with an `Authorization: Token …` header, which Node can set on
 * a WebSocket upgrade and a browser cannot.
 *
 * The mapping half — turning a stream of `Results` messages into the
 * `{confirmed, tail}` pair the notes UI and the HUD already render — is a pure
 * state machine (`TranscriptAssembler`) so it can be tested against recorded
 * fixtures with no network (tests/deepgram.test.ts).
 */

/** Deepgram's `linear16`: what the capture sidecar writes to fd 3. */
export const STREAM_ENCODING = 'linear16'
export const STREAM_SAMPLE_RATE = 16_000
export const STREAM_CHANNELS = 1

/**
 * Deepgram closes an idle connection after 10 s. Ping well inside that: a
 * lecture with a long silent stretch (a video playing muted, a pause for
 * questions) is a normal recording, not a dead one.
 */
const KEEPALIVE_EVERY_MS = 4_000
const KEEPALIVE_IDLE_MS = 3_000

/**
 * How long to wait after `CloseStream` for the flush `Results` + `Metadata`.
 * Past this the transcript we already have is the answer — better a slightly
 * clipped tail than a Stop button that never resolves.
 */
const FLUSH_TIMEOUT_MS = 6_000

/**
 * A silence gap between finals longer than this starts a new paragraph, and
 * continuous speakers who never pause that long break after this many
 * sentences instead. Ported verbatim from the Whisper engine's paragraphing so
 * structured notes keep the shape they had.
 */
export const PARAGRAPH_GAP_S = 1.75
export const MAX_SENTENCES_PER_PARAGRAPH = 4

/** The fields of a `Results` message this module reads. */
export interface ResultsMessage {
  type: string
  /** Seconds from the start of the stream */
  start: number
  duration: number
  is_final?: boolean
  channel: { alternatives: Array<{ transcript: string }> }
}

export interface Transcript {
  /** Settled text — append-only, so paragraph breaks in it never move */
  confirmed: string
  /** Latest interim, re-written on every message */
  tail: string
}

/**
 * Accumulates `Results` messages into `{confirmed, tail}`.
 *
 * Interim messages only ever replace the tail; `is_final` messages move text
 * into `confirmed`, which is never rewritten. That asymmetry is what lets
 * paragraphs live in the confirmed half only — the tail is re-issued from
 * scratch on every message, so structure shown there would flicker.
 */
export class TranscriptAssembler {
  private confirmed = ''
  private tail = ''
  private previousEnd: number | null = null
  private sentencesSinceBreak = 0

  /** True when the snapshot changed and the UI is worth updating. */
  accept(message: ResultsMessage): boolean {
    if (message.type !== 'Results') return false
    const text = (message.channel.alternatives[0]?.transcript ?? '').trim()

    if (!message.is_final) {
      if (text === this.tail) return false
      this.tail = text
      return true
    }

    // Silence produces empty finals. Skipping them without touching
    // `previousEnd` is deliberate: the gap that matters is between the last
    // *spoken* words and the next, which is exactly what a pause is.
    if (!text) {
      const hadTail = this.tail !== ''
      this.tail = ''
      return hadTail
    }

    this.append(text, message.start, message.start + message.duration)
    this.tail = ''
    return true
  }

  private append(text: string, start: number, end: number): void {
    if (this.previousEnd !== null) {
      const longPause = start - this.previousEnd > PARAGRAPH_GAP_S
      const budgetSpent =
        this.sentencesSinceBreak >= MAX_SENTENCES_PER_PARAGRAPH && endsSentence(this.confirmed)
      if (longPause || budgetSpent) {
        this.confirmed += '\n\n'
        this.sentencesSinceBreak = 0
      } else if (this.confirmed) {
        this.confirmed += ' '
      }
    } else if (this.confirmed) {
      this.confirmed += ' '
    }
    this.confirmed += text
    this.sentencesSinceBreak += [...text].filter((c) => '.!?'.includes(c)).length
    this.previousEnd = end
  }

  snapshot(): Transcript {
    return { confirmed: this.confirmed, tail: this.tail }
  }

  /** Everything said, for the `final` event — the tail is included because a
   * recording stopped mid-sentence still has words in it. */
  text(): string {
    return [this.confirmed, this.tail].filter(Boolean).join(' ').trim()
  }
}

function endsSentence(text: string): boolean {
  const last = text.trimEnd().slice(-1)
  return last !== '' && '.!?'.includes(last)
}

// MARK: - Streaming

export interface StreamOptions {
  apiKey: string
  model: string
  language: string
  /** Nova-3 key-term prompting — proper nouns a lecture keeps using */
  keyterms?: string[]
  onPartial: (t: Transcript) => void
  /** Non-fatal: the SDK is retrying underneath */
  onDropped?: () => void
  onError: (message: string) => void
}

export interface DeepgramStream {
  send(pcm: Buffer): void
  /** Flushes, waits for the trailing results, resolves with the transcript. */
  finish(): Promise<string>
  /** Tears down without waiting — the error and cancel paths. */
  abort(): void
}

export async function openDeepgramStream(options: StreamOptions): Promise<DeepgramStream> {
  const client = new DeepgramClient({ apiKey: options.apiKey })
  const assembler = new TranscriptAssembler()

  const socket = await client.listen.v1.connect({
    Authorization: `Token ${options.apiKey}`,
    model: options.model,
    language: options.language,
    encoding: STREAM_ENCODING,
    sample_rate: STREAM_SAMPLE_RATE,
    channels: STREAM_CHANNELS,
    // v5 sends WebSocket options as query params, so booleans go on the wire
    // as strings. Passing real booleans here silently drops them.
    interim_results: 'true',
    smart_format: 'true',
    // Both set explicitly: the API reference and the SDK examples disagree
    // about the defaults, so neither is worth inheriting.
    endpointing: 300,
    utterance_end_ms: 1_000,
    ...(options.keyterms?.length ? { keyterm: options.keyterms } : {}),
    // A blip mid-lecture is worth riding out; a dead network is not, and the
    // on-disk PCM is the real safety net either way (src/main/stt.ts).
    reconnectAttempts: 3
  })

  let lastMediaAt = Date.now()
  let closed = false
  let flushed: (() => void) | null = null

  socket.on('message', (message) => {
    if (message.type === 'Results') {
      if (assembler.accept(message as ResultsMessage)) options.onPartial(assembler.snapshot())
      return
    }
    // Metadata is Deepgram's end-of-stream receipt: everything it was going to
    // transcribe has been sent.
    if (message.type === 'Metadata') flushed?.()
  })

  socket.on('error', (error) => {
    options.onError(error.message || 'Deepgram connection error')
  })

  socket.on('close', () => {
    closed = true
    flushed?.()
  })

  socket.connect()
  await socket.waitForOpen()

  const keepAlive = setInterval(() => {
    if (closed) return
    if (Date.now() - lastMediaAt < KEEPALIVE_IDLE_MS) return
    try {
      socket.sendKeepAlive({ type: 'KeepAlive' })
    } catch {
      /* socket already going down — close/error handlers own it */
    }
  }, KEEPALIVE_EVERY_MS)
  keepAlive.unref()

  const teardown = (): void => {
    clearInterval(keepAlive)
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }

  return {
    send(pcm) {
      if (closed) return
      lastMediaAt = Date.now()
      try {
        socket.sendMedia(pcm)
      } catch {
        // A send racing the close is expected on teardown; a genuine failure
        // surfaces through the error handler.
      }
    },

    async finish() {
      if (!closed) {
        try {
          socket.sendCloseStream({ type: 'CloseStream' })
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
            timer.unref()
            flushed = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        } catch {
          /* fall through to whatever we already have */
        }
      }
      teardown()
      return assembler.text()
    },

    abort: teardown
  }
}

// MARK: - REST

export interface DeepgramModel {
  /** What goes on the wire as the `model` param */
  id: string
  label: string
  languages: string[]
}

/**
 * Streaming models available to this key, asked at runtime rather than
 * hardcoded — the same rule the agent model lists follow (CLAUDE.md). The
 * caller falls back to the default when this throws or comes back empty.
 */
/**
 * Cached for the session, like the agent model catalogs (agent-models.ts).
 * The response is ~400 rows and the list only changes when Deepgram ships a
 * model, so refetching it every time the Voice pane opens buys nothing and
 * costs a visible pause. Keyed by the API key, so replacing the key refetches.
 */
let modelCache: { key: string; models: DeepgramModel[] } | null = null

export async function listStreamingModels(apiKey: string): Promise<DeepgramModel[]> {
  if (modelCache?.key === apiKey) return modelCache.models

  const client = new DeepgramClient({ apiKey })
  const response = await client.manage.v1.models.list()

  // The catalog lists one row per model *version*, many sharing a canonical
  // name — and the canonical name is what goes on the wire. Collapsing them is
  // not cosmetic: leaving duplicates makes the picker dozens of rows long and
  // hands React repeated keys for its option list.
  const byId = new Map<string, DeepgramModel>()
  for (const model of response.stt ?? []) {
    const id = model.canonical_name
    if (!model.streaming || !id) continue
    const existing = byId.get(id)
    byId.set(id, {
      id,
      // The canonical name is the label, not `name`. `name` is a display
      // fragment — Deepgram returns "2-automotive" for what it calls
      // nova-2-automotive — which is ambiguous on its own and unsearchable by
      // the word a user would actually type.
      label: id,
      // Versions can differ in coverage; the union is what the model supports.
      languages: [
        ...new Set([...(existing?.languages ?? []), ...(model.languages ?? [])])
      ].sort()
    })
  }
  const models = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
  modelCache = { key: apiKey, models }
  return models
}

/** Error sentence when the key doesn't work, else null. */
export async function verifyKey(apiKey: string): Promise<string | null> {
  try {
    await new DeepgramClient({ apiKey }).manage.v1.models.list()
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return /401|unauthor|forbidden|invalid/i.test(message)
      ? 'Deepgram rejected that key.'
      : `Could not reach Deepgram: ${message}`
  }
}

/**
 * Pre-recorded transcription of one WAV chunk — the recovery path for audio
 * whose live stream died (src/main/stt.ts). `paragraphs` does the shaping the
 * streaming assembler does by hand, so a recovered transcript reads the same.
 */
export async function transcribeWav(
  apiKey: string,
  wav: Buffer,
  options: { model: string; language: string }
): Promise<string> {
  const client = new DeepgramClient({ apiKey })
  const response = await client.listen.v1.media.transcribeFile(wav, {
    model: options.model,
    language: options.language,
    // Batch takes real booleans; only the WebSocket params are stringly-typed.
    smart_format: true,
    punctuate: true,
    paragraphs: true
  })
  // The other arm of the union is the async-callback receipt, which we never
  // ask for — a desktop app has nowhere to host a public callback URL.
  if (!('results' in response)) return ''
  const alternative = response.results.channels[0]?.alternatives?.[0]
  // `paragraphs.transcript` carries the blank lines; the flat `transcript` is
  // one long line, so it is only the fallback.
  return (alternative?.paragraphs?.transcript ?? alternative?.transcript ?? '').trim()
}
