import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_APPEARANCE, DEFAULT_LAYOUT, type SettingsFile } from '../shared/appearance'
import { normalizeAgents, type AgentChoice, type AgentTask } from '../shared/agents'
import { normalizeKeybinds } from '../shared/keybinds'
import { normalizeStt } from '../shared/stt'
import { loadProjects, saveProjects } from './projects'

/**
 * App-wide user settings (appearance, agent assignments, speech). Same shape as
 * projects.json: the renderer owns the state; main loads/saves the blob at
 * userData/settings.json. Loads deep-merge over defaults so settings written
 * by older versions pick up newly-added colors and newly-added features.
 *
 * Keybinds are the one key with a second source: the voice hotkey used to live
 * in projects.json as `todoHotkey`, so an install that set it there keeps it
 * until the user changes the binding here.
 */

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

const legacyHotkey = (): string | undefined => {
  try {
    return loadProjects().todoHotkey
  } catch {
    return undefined
  }
}

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
      agents: normalizeAgents(parsed.agents),
      stt: normalizeStt(parsed.stt),
      layout: { ...DEFAULT_LAYOUT, ...parsed.layout },
      keybinds: normalizeKeybinds(parsed.keybinds, legacyHotkey())
    }
  } catch {
    return {
      appearance: DEFAULT_APPEARANCE,
      agents: normalizeAgents(undefined),
      stt: normalizeStt(undefined),
      layout: DEFAULT_LAYOUT,
      keybinds: normalizeKeybinds(undefined, legacyHotkey())
    }
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

/**
 * Move a hotkey set before this pane existed into settings.json and drop it
 * from projects.json, so there is one place the binding lives. Runs at launch,
 * before the renderer can save either file over the top.
 */
export function migrateTodoHotkey(): void {
  const projects = loadProjects()
  if (!projects.todoHotkey) return
  // loadSettings already adopts it — this just makes the adoption durable
  saveSettings(loadSettings())
  const { todoHotkey: _moved, ...rest } = projects
  saveProjects(rest)
}

export function saveSettings(file: SettingsFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
}
