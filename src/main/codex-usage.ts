import { spawn } from 'node:child_process'
import type { AccountUsage, RateWindow } from '../shared/account-usage'
import { buildPtyEnv } from './terminals'

/**
 * Codex account windows through its own app-server API. Unlike the Claude
 * reader, this never opens credential files or calls an undocumented endpoint:
 * the CLI authenticates the request and returns only the rate-limit snapshot.
 */

const TTL_MS = 60_000
const TIMEOUT_MS = 5_000
const RATE_LIMITS_ID = 2

let cached: { at: number; value: AccountUsage | null } | null = null
let inFlight: Promise<AccountUsage | null> | null = null

interface WindowSnapshot {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

interface RateSnapshot {
  primary?: WindowSnapshot | null
  secondary?: WindowSnapshot | null
}

function windowType(minutes: number | undefined, priority: number): string {
  if (minutes === 300) return 'five_hour'
  if (minutes === 10_080) return 'seven_day'
  if (!minutes) return priority === 0 ? 'primary' : 'secondary'
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function rateWindow(value: WindowSnapshot | null | undefined, priority: number): RateWindow | null {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent))
    return null
  const duration =
    typeof value.windowDurationMins === 'number' && Number.isFinite(value.windowDurationMins)
      ? value.windowDurationMins
      : undefined
  const resetsAt =
    typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
      ? value.resetsAt
      : undefined
  return {
    type: windowType(duration, priority),
    used: Math.max(0, Math.min(100, value.usedPercent)),
    ...(resetsAt ? { resetsAt } : {}),
    priority
  }
}

export function parseCodexAccountUsage(payload: unknown, fetchedAt: number): AccountUsage | null {
  if (!payload || typeof payload !== 'object') return null
  const result = payload as Record<string, unknown>
  const buckets = result.rateLimitsByLimitId
  const byId = buckets && typeof buckets === 'object' ? (buckets as Record<string, unknown>) : null
  const snapshot = (byId?.codex ?? result.rateLimits) as RateSnapshot | undefined
  if (!snapshot || typeof snapshot !== 'object') return null
  const windows = [rateWindow(snapshot.primary, 0), rateWindow(snapshot.secondary, 1)].filter(
    (window): window is RateWindow => window !== null
  )
  return windows.length ? { windows, fetchedAt } : null
}

async function fetchUsage(): Promise<AccountUsage | null> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/zsh', ['-ilc', 'codex "$@"', 'chewo', 'app-server'], {
      env: buildPtyEnv(process.env)
    })
    let settled = false
    let buffer = ''
    const finish = (value: AccountUsage | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdin.end()
      proc.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { id?: unknown; result?: unknown }
        try {
          message = JSON.parse(line) as { id?: unknown; result?: unknown }
        } catch {
          continue
        }
        if (message.id === RATE_LIMITS_ID)
          finish(parseCodexAccountUsage(message.result, Date.now()))
      }
    })
    proc.on('error', () => finish(null))
    proc.stdin.on('error', () => finish(null))
    proc.on('close', () => finish(null))
    proc.stderr.resume()

    for (const message of [
      {
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'chewo', title: 'Chewo', version: '1' } }
      },
      { method: 'initialized', params: {} },
      { method: 'account/rateLimits/read', id: RATE_LIMITS_ID }
    ])
      proc.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

export function codexAccountUsage(force = false): Promise<AccountUsage | null> {
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
