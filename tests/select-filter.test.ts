import { describe, expect, test } from 'vitest'
import { filterOptions } from '../src/renderer/src/selectFilter'

/**
 * The searchable Select's filter. The lists it exists for are Deepgram's —
 * a long per-model language set, where scrolling is not a realistic way to
 * find "Spanish (Latin America)".
 */

const languages = [
  { value: 'en-US', label: 'English (United States)', detail: 'en-US' },
  { value: 'en-GB', label: 'English (United Kingdom)', detail: 'en-GB' },
  { value: 'es-419', label: 'Latin American Spanish', detail: 'es-419' },
  { value: 'de', label: 'German', detail: 'de' },
  { value: 'multi', label: 'Multilingual', detail: 'multi' }
]

const models = [
  { value: 'nova-3-general', label: 'Nova 3 General', detail: '38 languages' },
  { value: 'nova-3-medical', label: 'Nova 3 Medical', detail: 'en' },
  { value: 'nova-2-general', label: 'Nova 2 General', detail: '36 languages' },
  { value: 'whisper-large', label: 'Whisper Large', detail: '99 languages' }
]

describe('filterOptions', () => {
  test('an empty query returns everything, untouched', () => {
    expect(filterOptions(languages, '')).toEqual(languages)
    expect(filterOptions(languages, '   ')).toEqual(languages)
  })

  test('matches on the human label', () => {
    expect(filterOptions(languages, 'german').map((o) => o.value)).toEqual(['de'])
  })

  test('matches on the raw tag, which is what Deepgram calls it', () => {
    expect(filterOptions(languages, 'es-419').map((o) => o.value)).toEqual(['es-419'])
  })

  test('a partial match keeps every option that contains it', () => {
    expect(filterOptions(languages, 'english').map((o) => o.value)).toEqual(['en-US', 'en-GB'])
  })

  test('is case-insensitive both ways', () => {
    expect(filterOptions(languages, 'GERMAN')).toHaveLength(1)
    expect(filterOptions(models, 'NOVA')).toHaveLength(3)
  })

  test('surrounding whitespace is ignored', () => {
    expect(filterOptions(models, '  nova-3  ').map((o) => o.value)).toEqual([
      'nova-3-general',
      'nova-3-medical'
    ])
  })

  test('"nova" finds every Nova model — the case that was reported broken', () => {
    expect(filterOptions(models, 'nova').map((o) => o.value)).toEqual([
      'nova-3-general',
      'nova-3-medical',
      'nova-2-general'
    ])
  })

  test('gibberish matches nothing', () => {
    expect(filterOptions(models, 'qzxjkw')).toEqual([])
    expect(filterOptions(languages, 'qzxjkw')).toEqual([])
  })

  test('an option with no detail is still searchable by label and value', () => {
    const sparse = [{ value: 'base', label: 'Base' }]
    expect(filterOptions(sparse, 'base')).toHaveLength(1)
    expect(filterOptions(sparse, 'Ba')).toHaveLength(1)
    expect(filterOptions(sparse, 'zzz')).toHaveLength(0)
  })

  test('matches the detail alone — the language count on a model row', () => {
    expect(filterOptions(models, '99 languages').map((o) => o.value)).toEqual(['whisper-large'])
  })
})
