import { describe, expect, test } from 'vitest'
import {
  DEFAULT_LOCAL_FILES,
  matchesLocalFile,
  parseLocalFilePatterns
} from '../src/shared/local-files'

describe('parseLocalFilePatterns', () => {
  test('empty input falls back to the defaults', () => {
    expect(parseLocalFilePatterns()).toBe(DEFAULT_LOCAL_FILES)
    expect(parseLocalFilePatterns('')).toBe(DEFAULT_LOCAL_FILES)
    expect(parseLocalFilePatterns('  \n\n  ')).toBe(DEFAULT_LOCAL_FILES)
    expect(parseLocalFilePatterns('# only a comment')).toBe(DEFAULT_LOCAL_FILES)
  })

  test('one pattern per line, trimmed', () => {
    expect(parseLocalFilePatterns('.env\n\n  config/local.json  \n# note\n')).toEqual([
      '.env',
      'config/local.json'
    ])
  })
})

describe('the defaults', () => {
  const wanted = (path: string): boolean => matchesLocalFile(path, DEFAULT_LOCAL_FILES)

  test('take every env file, at any depth', () => {
    expect(wanted('.env')).toBe(true)
    expect(wanted('.env.local')).toBe(true)
    expect(wanted('.env.development.local')).toBe(true)
    expect(wanted('apps/web/.env')).toBe(true)
    expect(wanted('packages/api/.env.production')).toBe(true)
  })

  test('leave the committed examples, which the checkout already has', () => {
    expect(wanted('.env.example')).toBe(false)
    expect(wanted('.env.sample')).toBe(false)
    expect(wanted('.env.template')).toBe(false)
  })

  test('leave everything else git ignores', () => {
    expect(wanted('dist/')).toBe(false)
    expect(wanted('coverage/lcov.info')).toBe(false)
    expect(wanted('npm-debug.log')).toBe(false)
    // not an env file — the pattern is `.env.*`, not `*env*`
    expect(wanted('environment.ts')).toBe(false)
  })
})

describe('pattern syntax', () => {
  test('no slash matches the basename at any depth; a slash pins the path', () => {
    expect(matchesLocalFile('a/b/secrets.json', ['secrets.json'])).toBe(true)
    expect(matchesLocalFile('a/b/secrets.json', ['a/b/secrets.json'])).toBe(true)
    expect(matchesLocalFile('a/b/secrets.json', ['b/secrets.json'])).toBe(false)
    expect(matchesLocalFile('secrets.json', ['config/secrets.json'])).toBe(false)
  })

  test('* stops at a separator, ** crosses it', () => {
    expect(matchesLocalFile('config/db.local.json', ['config/*.json'])).toBe(true)
    expect(matchesLocalFile('config/aws/db.json', ['config/*.json'])).toBe(false)
    expect(matchesLocalFile('config/aws/db.json', ['config/**/*.json'])).toBe(true)
  })

  test('last match wins, so a later ! un-takes an earlier take', () => {
    expect(matchesLocalFile('.env.example', ['.env.*', '!*.example'])).toBe(false)
    expect(matchesLocalFile('.env.example', ['!*.example', '.env.*'])).toBe(true)
  })

  test('a trailing slash on either side is not a mismatch', () => {
    expect(matchesLocalFile('.certs/', ['.certs'])).toBe(true)
    expect(matchesLocalFile('.certs', ['.certs/'])).toBe(true)
  })

  test('dots are literal, not any-character', () => {
    expect(matchesLocalFile('xenv', ['.env'])).toBe(false)
  })
})
