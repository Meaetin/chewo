import { describe, expect, test } from 'vitest'
import {
  DEFAULT_STT_MODEL,
  DEFAULT_STT_SETTINGS,
  formatRate,
  MULTI_LANGUAGE,
  normalizeStt,
  STT_TIERS,
  tierFor
} from '../src/shared/stt'

/**
 * Settings migration for the move off local Whisper, and for Deepgram's wire
 * aliases.
 *
 * The alias case is not cosmetic: `nova-3` transcribes fine but is absent from
 * `GET /v1/models`, so a picker built from the catalog has no row matching it
 * — which is how the stored model silently drifted to an unrelated one.
 */

describe('normalizeStt', () => {
  test('a fresh install gets the catalog-listed default, not the alias', () => {
    expect(normalizeStt(undefined)).toEqual(DEFAULT_STT_SETTINGS)
    expect(DEFAULT_STT_MODEL).toBe('nova-3-general')
  })

  test('a Whisper variant from before the switch falls back to the default', () => {
    expect(normalizeStt({ model: 'openai_whisper-large-v3-v20240930_turbo' }).model).toBe(
      DEFAULT_STT_MODEL
    )
    expect(normalizeStt({ model: 'openai_whisper-base.en' }).model).toBe(DEFAULT_STT_MODEL)
  })

  // Pairs are from Deepgram's model reference ("`nova-3` or `nova-3-general`");
  // every target was also seen in a real GET /v1/models response.
  test('wire aliases migrate to the names the catalog actually lists', () => {
    expect(normalizeStt({ model: 'nova-3' }).model).toBe('nova-3-general')
    expect(normalizeStt({ model: 'nova-2' }).model).toBe('nova-2-general')
    expect(normalizeStt({ model: 'nova' }).model).toBe('nova-general')
    expect(normalizeStt({ model: 'enhanced' }).model).toBe('enhanced-general')
  })

  test('`base` is left alone — the catalog has no base-general to point at', () => {
    expect(normalizeStt({ model: 'base' }).model).toBe('base')
  })

  test('a real catalog id is left exactly as it is', () => {
    for (const id of ['nova-3-medical', 'nova-2-automotive', 'whisper-large', 'enhanced-general']) {
      expect(normalizeStt({ model: id }).model).toBe(id)
    }
  })

  test('an empty or missing model falls back rather than going on the wire blank', () => {
    expect(normalizeStt({ model: '' }).model).toBe(DEFAULT_STT_MODEL)
    expect(normalizeStt({ language: 'de' }).model).toBe(DEFAULT_STT_MODEL)
  })

  test('language is preserved, and defaults when absent', () => {
    expect(normalizeStt({ language: 'es-419' }).language).toBe('es-419')
    expect(normalizeStt({ model: 'nova-3' }).language).toBe('en')
  })

  test('keyterms are kept, trimmed of blanks, and omitted when empty', () => {
    expect(normalizeStt({ keyterms: ['Nyquist', ' ', 'eigenvector'] }).keyterms).toEqual([
      'Nyquist',
      'eigenvector'
    ])
    expect(normalizeStt({ keyterms: [] }).keyterms).toBeUndefined()
    expect(normalizeStt(undefined).keyterms).toBeUndefined()
  })
})

describe('model tiers', () => {
  test('the multilingual tier is chosen by language, not by a separate model', () => {
    expect(tierFor({ model: 'nova-3-general', language: 'en' }).key).toBe('mono')
    expect(tierFor({ model: 'nova-3-general', language: MULTI_LANGUAGE }).key).toBe('multi')
    // Both tiers ride the same model id — only the language and the rate differ
    expect(STT_TIERS[0].model).toBe(STT_TIERS[1].model)
  })

  test('multilingual costs more, and both rates match Deepgram pay-as-you-go', () => {
    const mono = STT_TIERS.find((t) => t.key === 'mono')!
    const multi = STT_TIERS.find((t) => t.key === 'multi')!
    expect(mono.pricePerMin).toBe(0.0048)
    expect(multi.pricePerMin).toBe(0.0058)
    expect(multi.pricePerMin).toBeGreaterThan(mono.pricePerMin)
  })

  test('an unknown model still resolves to a tier rather than crashing', () => {
    expect(tierFor({ model: 'nova-2-automotive', language: 'en' }).key).toBe('mono')
  })

  test('formatRate turns a per-minute rate into something legible', () => {
    expect(formatRate(0.0048)).toBe('$0.0048/min · about $0.29 an hour')
    expect(formatRate(0.0058)).toBe('$0.0058/min · about $0.35 an hour')
  })

  test('Flux is not offered — it needs listen.v2, which this app does not speak', () => {
    expect(STT_TIERS.some((t) => t.model.includes('flux'))).toBe(false)
  })
})
