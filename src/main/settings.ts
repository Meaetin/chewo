import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_APPEARANCE, type SettingsFile } from '../shared/appearance'

/**
 * App-wide user settings (appearance for now). Same shape as projects.json:
 * the renderer owns the state; main loads/saves the blob at
 * userData/settings.json. Loads deep-merge over defaults so settings written
 * by older versions pick up newly-added colors.
 */

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): SettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as Partial<SettingsFile>
    const a = parsed.appearance
    return {
      appearance: {
        ...DEFAULT_APPEARANCE,
        ...a,
        terminal: { ...DEFAULT_APPEARANCE.terminal, ...a?.terminal },
        editor: { ...DEFAULT_APPEARANCE.editor, ...a?.editor },
        notes: { ...DEFAULT_APPEARANCE.notes, ...a?.notes }
      }
    }
  } catch {
    return { appearance: DEFAULT_APPEARANCE }
  }
}

export function saveSettings(file: SettingsFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
}
