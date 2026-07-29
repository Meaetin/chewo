/**
 * Speech-to-text settings (SPEC-NOTES.md §6).
 *
 * One choice serves both dictation surfaces — notes and to-do voice commands.
 * There is no longer a resident model to thrash, but a per-feature split would
 * still mean two vocabularies and two languages to keep straight for no gain.
 *
 * The model list is never hardcoded: streaming models are enumerated from
 * Deepgram at runtime (`stt:models`), the same rule the agent model lists
 * follow. Only the default below is fixed, and only as the choice a fresh
 * install starts from.
 */

/**
 * Deepgram's current flagship streaming model, and the fallback whenever the
 * catalog can't be fetched (no key yet, or offline).
 *
 * The canonical name, not the `nova-3` alias: the alias works on the wire but
 * is absent from `GET /v1/models`, so a picker built from the catalog would
 * have no row matching it — and a select with no matching option is how the
 * model setting silently drifted once already.
 */
export const DEFAULT_STT_MODEL = 'nova-3-general'

/**
 * Wire aliases Deepgram accepts but never lists, mapped to what it lists.
 *
 * From Deepgram's model reference, which writes each pair as "`nova-3` or
 * `nova-3-general`"; every target here was also confirmed present in a real
 * `GET /v1/models` response. `base` is deliberately absent: the docs call its
 * variant `base-general`, but the catalog returns a bare `general`, and
 * mapping to an id the catalog lacks is what created the "no matching option"
 * drift in the first place.
 */
const MODEL_ALIASES: Record<string, string> = {
  'nova-3': 'nova-3-general',
  'nova-2': 'nova-2-general',
  nova: 'nova-general',
  enhanced: 'enhanced-general'
}

export interface SttSettings {
  /** Deepgram model id, passed verbatim as the `model` param */
  model: string
  /** BCP-47 tag hinting the spoken language */
  language: string
  /**
   * Nova-3 key-term prompting: proper nouns a course keeps using that a
   * general model mangles ("Nyquist", a lecturer's name).
   */
  keyterms?: string[]
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  model: DEFAULT_STT_MODEL,
  language: 'en'
}

/**
 * Also the migration point for settings written before dictation moved off
 * WhisperKit: those hold a Whisper variant folder name, which Deepgram would
 * reject outright, so anything of that shape falls back to the default.
 */
export function normalizeStt(partial: Partial<SttSettings> | undefined): SttSettings {
  const raw = partial?.model
  const model = typeof raw === 'string' ? (MODEL_ALIASES[raw] ?? raw) : raw
  const usable = typeof model === 'string' && model !== '' && !model.startsWith('openai_whisper-')
  const language = partial?.language
  const keyterms = partial?.keyterms

  return {
    model: usable ? model : DEFAULT_STT_MODEL,
    language: typeof language === 'string' && language ? language : DEFAULT_STT_SETTINGS.language,
    ...(Array.isArray(keyterms) && keyterms.length
      ? { keyterms: keyterms.filter((t): t is string => typeof t === 'string' && t.trim() !== '') }
      : {})
  }
}

/** What the dictation UI needs to decide whether it can record at all. */
export interface SttStatus {
  /** A Deepgram key is stored. Nothing can record without one. */
  hasKey: boolean
  /** Recordings whose live stream died and whose audio is still on disk */
  pendingRecoveries: PendingRecovery[]
}

/** One recoverable recording, as shown in Settings → Voice. */
export interface PendingRecovery {
  id: string
  startedAt: string
  durationS: number
  bytes: number
  /** Lesson the transcript belongs to; absent for to-do voice commands */
  lessonPath?: string
}

/** One row in the Voice settings model picker. */
export interface SttModelInfo {
  id: string
  label: string
  languages: string[]
}

/**
 * What the Voice pane actually offers.
 *
 * Deepgram lists 41 streaming models across ~400 catalog rows, nearly all of
 * them domain variants (drivethru, atc, voicemail) or superseded generations.
 * For taking lecture notes the real choice is one language or several, so the
 * picker offers exactly that. The full catalog is still what fills the
 * language list — this only curates the model.
 *
 * Multilingual is not a separate model: it is `nova-3-general` with
 * `language=multi`, which Deepgram bills at its own rate.
 *
 * Flux is deliberately absent. It is served over `listen.v2` with a different
 * message protocol, and this app speaks `listen.v1` — offering it would ship a
 * option that cannot work.
 */
export interface SttTier {
  key: 'mono' | 'multi'
  /** Wire value for the `model` param */
  model: string
  label: string
  detail: string
  /** USD per minute, Deepgram pay-as-you-go */
  pricePerMin: number
}

export const STT_TIERS: SttTier[] = [
  {
    key: 'mono',
    model: 'nova-3-general',
    label: 'Nova-3',
    detail: 'One language per recording. Most accurate, and the cheapest.',
    pricePerMin: 0.0048
  },
  {
    key: 'multi',
    model: 'nova-3-general',
    label: 'Nova-3 Multilingual',
    detail: 'Recognises several languages at once, including mid-sentence switches.',
    pricePerMin: 0.0058
  }
]

/** Multilingual is selected by the language, not the model id. */
export function tierFor(settings: SttSettings): SttTier {
  const key = settings.language === MULTI_LANGUAGE ? 'multi' : 'mono'
  return STT_TIERS.find((t) => t.key === key) ?? STT_TIERS[0]
}

export const MULTI_LANGUAGE = 'multi'

/** "$0.0048/min · about $0.29 an hour" — per-minute rates mean nothing alone. */
export function formatRate(pricePerMin: number): string {
  return `$${pricePerMin.toFixed(4)}/min · about $${(pricePerMin * 60).toFixed(2)} an hour`
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

/** "1h 04m" / "4m 12s" / "38s" — recording lengths, not clock times. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
