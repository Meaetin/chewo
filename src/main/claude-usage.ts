import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseAccountUsage, type AccountUsage } from '../shared/account-usage'

const run = promisify(execFile)

/**
 * The percentages `/usage` prints, fetched the way the CLI fetches them.
 *
 * This is the one place Chewo depends on something Anthropic does not
 * document. It exists because the alternative was worse: the chat stream
 * carries no utilization figure anywhere (`rate_limit_event` is a status and a
 * reset time), so a "% used" readout is either this call or a fabricated
 * number, and a number on screen is read as measured.
 *
 * Three rules keep it from becoming a liability:
 *
 * 1. **It never blocks anything.** Every failure path — no credentials, an
 *    expired token, a 401, a shape we do not recognise — returns null, and the
 *    composer falls back to naming the window and its reset time. Nothing in
 *    the app waits on this call.
 * 2. **The token is read, used, and dropped.** It is never logged, never
 *    cached on disk, never sent anywhere except api.anthropic.com, and never
 *    crosses IPC to the renderer. Only the parsed percentages do.
 * 3. **We never refresh it.** An expired token means the readout goes quiet
 *    until Claude Code refreshes it itself, which it does on its own schedule.
 *    Minting tokens against someone else's OAuth client is not our business.
 */

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
/** macOS Keychain entry Claude Code writes; the file is the fallback */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json')

/** A minute is far finer than these windows move, and it means a dozen panes
 *  asking at once cost one request. */
const TTL_MS = 60_000
const TIMEOUT_MS = 5_000

let cached: { at: number; value: AccountUsage | null } | null = null
/** One request in flight at a time — panes ask independently and all at once */
let inFlight: Promise<AccountUsage | null> | null = null

async function credentialsJson(): Promise<string | null> {
  try {
    const { stdout } = await run('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w'
    ])
    if (stdout.trim()) return stdout.trim()
  } catch {
    // Not on the keychain (or the user declined) — try the file
  }
  try {
    return await readFile(CREDENTIALS_FILE, 'utf8')
  } catch {
    return null
  }
}

/**
 * The OAuth access token, if there is a live one. Returns null rather than
 * throwing for every shape this has been seen in — the file is Claude Code's,
 * not ours, and it is free to change.
 */
function accessToken(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const root = parsed as Record<string, unknown>
  const oauth = (root?.claudeAiOauth ?? root) as Record<string, unknown> | undefined
  const token = oauth?.accessToken
  if (typeof token !== 'string' || !token) return null

  // Stored in ms in every sample seen, but a seconds value would read as 1970
  // and disable the feature forever, so both are accepted
  const expiresAt = oauth?.expiresAt
  if (typeof expiresAt === 'number' && expiresAt > 0) {
    const ms = expiresAt > 1e11 ? expiresAt : expiresAt * 1000
    if (ms < Date.now()) return null
  }
  return token
}

async function fetchUsage(): Promise<AccountUsage | null> {
  const raw = await credentialsJson()
  const token = raw && accessToken(raw)
  if (!token) return null

  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        // The header the CLI's own OAuth requests carry; without it the
        // endpoint answers 401 for an OAuth (rather than API-key) token
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return null
    const usage = parseAccountUsage(await res.json(), Date.now())
    // A 200 with a shape we cannot read is a failure, not an empty account
    return usage.windows.length > 0 ? usage : null
  } catch {
    return null
  }
}

/**
 * Cached account usage. `force` skips the TTL — used when a turn has just
 * ended, which is the one moment the numbers are known to have moved.
 */
export function accountUsage(force = false): Promise<AccountUsage | null> {
  const fresh = cached && Date.now() - cached.at < TTL_MS
  if (fresh && !force) return Promise.resolve(cached!.value)
  if (inFlight) return inFlight

  inFlight = fetchUsage()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
