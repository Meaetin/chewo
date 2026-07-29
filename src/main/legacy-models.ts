import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The Whisper weights left behind when dictation moved to Deepgram.
 *
 * Deleting them at launch would be taking a couple of gigabytes of the user's
 * data without asking, and an offline user downgrading to an older build would
 * find them gone. So they stay until the Voice pane's reclaim button removes
 * them, and this module exists only to size and delete that directory.
 *
 * Deletable outright once enough releases have passed that nobody is upgrading
 * across the switch.
 */

const LEGACY_MODELS_DIR = join(homedir(), '.chewo', 'models')

export function legacyModelsDir(): string {
  return LEGACY_MODELS_DIR
}

/** Bytes on disk, or 0 when there is nothing left to reclaim. */
export function legacyModelsBytes(): number {
  if (!existsSync(LEGACY_MODELS_DIR)) return 0
  let total = 0
  const walk = (path: string): void => {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      return // vanished mid-walk, or unreadable
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name))
    } else if (stat.isFile()) {
      total += stat.size
    }
  }
  walk(LEGACY_MODELS_DIR)
  return total
}

export function removeLegacyModels(): void {
  try {
    rmSync(LEGACY_MODELS_DIR, { recursive: true, force: true })
  } catch {
    /* a directory we can't remove leaves the button visible — no harm done */
  }
}
