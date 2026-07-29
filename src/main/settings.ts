import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_APPEARANCE, type SettingsFile } from '../shared/appearance'
import { normalizeAgents, type AgentChoice, type AgentTask } from '../shared/agents'

/**
 * App-wide user settings (appearance + agent assignments). Same shape as
 * projects.json: the renderer owns the state; main loads/saves the blob at
 * userData/settings.json. Loads deep-merge over defaults so settings written
 * by older versions pick up newly-added colors and newly-added features.
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
      },
      agents: normalizeAgents(parsed.agents)
    }
  } catch {
    return { appearance: DEFAULT_APPEARANCE, agents: normalizeAgents(undefined) }
  }
}

/**
 * Which agent runs a given headless feature. Read at call time rather than
 * cached so a change in the settings tab takes effect on the next run without
 * a restart — these are one-shot spawns, so there is nothing to reconnect.
 */
export function agentFor(task: AgentTask): AgentChoice {
  return loadSettings().agents[task]
}

export function saveSettings(file: SettingsFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
}
