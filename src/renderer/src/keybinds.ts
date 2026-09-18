import { createContext, useContext } from 'react'
import {
  DEFAULT_KEYBINDS,
  formatKeybind,
  matchesKeybind,
  type KeybindId,
  type KeybindMap
} from '../../shared/keybinds'

/**
 * The resolved keybind map, read by every listener and every shortcut hint.
 *
 * App owns the state and provides it here rather than each component loading
 * settings for itself: a rebind has to reach the listener and the button label
 * that names it in the same render, or the tooltip starts lying.
 *
 * The default is the shipped map, so a component rendered outside the provider
 * (a test, a preview) still behaves like a fresh install.
 */
export const KeybindContext = createContext<KeybindMap>(DEFAULT_KEYBINDS)

export const useKeybinds = (): KeybindMap => useContext(KeybindContext)

/** The accelerator bound to a command, e.g. `CommandOrControl+Shift+E`. */
export const useKeybind = (id: KeybindId): string => useKeybinds()[id]

/** The same binding written for a human, e.g. `⇧⌘E`. */
export const useKeybindLabel = (id: KeybindId): string => formatKeybind(useKeybinds()[id])

/**
 * A module-level mirror of the same map, for the one surface that lives outside
 * React's tree: CodeMirror's find panel is rendered into its own root by the
 * editor extension, so no provider reaches it. App keeps this current.
 */
let mirror: KeybindMap = DEFAULT_KEYBINDS
export const setKeybindMirror = (map: KeybindMap): void => {
  mirror = map
}
export const keybindNow = (id: KeybindId): string => mirror[id]

/**
 * True while the settings pane is waiting for a chord. Listeners that run in
 * the **capture** phase have to check it: the recorder stops propagation, which
 * silences every bubble-phase shortcut, but not a capture listener registered
 * before it.
 */
let armed = false
export const setKeybindRecording = (on: boolean): void => {
  armed = on
}
export const keybindRecording = (): boolean => armed

export { formatKeybind, matchesKeybind }
