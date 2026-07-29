import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Secrets the app itself holds, encrypted at rest through the macOS Keychain
 * (`safeStorage`).
 *
 * Deliberately NOT part of settings.json: the renderer owns that blob and
 * writes the whole thing back on every change, so a key stored there would
 * round-trip through a browser context on each keystroke in the appearance
 * pane. Nothing here ever sends plaintext to the renderer — the UI asks
 * `hasDeepgramKey()` and gets a boolean.
 *
 * This is the first credential Chewo carries. Every other integration shells
 * out to a CLI the user has already signed in to (see CLAUDE.md); Deepgram has
 * no CLI to borrow an identity from, so the app has to hold the key itself
 * (docs/decisions.md, 2026-07-29).
 */

interface CredentialsFile {
  /** base64 of the safeStorage-encrypted key */
  deepgram?: string
}

const filePath = (): string => join(app.getPath('userData'), 'credentials.json')

function load(): CredentialsFile {
  try {
    return JSON.parse(readFileSync(filePath(), 'utf8')) as CredentialsFile
  } catch {
    return {}
  }
}

function save(file: CredentialsFile): void {
  const path = filePath()
  if (Object.keys(file).length === 0) {
    // Leaving an empty `{}` behind reads as "a store exists but is broken";
    // no file is the same state a fresh install has.
    if (existsSync(path)) rmSync(path)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
}

export function hasDeepgramKey(): boolean {
  return deepgramKey() !== null
}

/**
 * Main-process only. Never expose this over IPC — the whole point of keeping
 * the Deepgram connection in main is that the key stays on this side.
 */
export function deepgramKey(): string | null {
  const stored = load().deepgram
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // Keychain entry lost (restored Mac, new login keychain) — the ciphertext
    // is dead weight, so report "no key" and let the user set it again.
    return null
  }
}

/** Error sentence when the key can't be stored, else null. */
export function setDeepgramKey(key: string): string | null {
  const trimmed = key.trim()
  if (!trimmed) return 'Enter a Deepgram API key.'
  if (!safeStorage.isEncryptionAvailable())
    return 'macOS Keychain is unavailable, so the key cannot be stored securely.'
  save({ ...load(), deepgram: safeStorage.encryptString(trimmed).toString('base64') })
  return null
}

export function clearDeepgramKey(): void {
  const file = load()
  delete file.deepgram
  save(file)
}
