/**
 * Every keyboard shortcut the app owns, in one registry.
 *
 * Bindings are stored in **Electron accelerator syntax** ("CommandOrControl+Shift+E")
 * because `globalShortcut` takes nothing else, and the voice hotkey is a real
 * system-wide registration. `matchesKeybind` reads the same strings against DOM
 * keyboard events, so one stored value serves both the window listeners and the
 * global one — there is no second format to keep in step.
 *
 * Three rules the matcher follows, all deliberate:
 *
 * 1. **Modifiers match exactly.** `Command+P` must not fire on ⌘⇧P, or the
 *    composer's dictation toggle would steal the run shortcut. `CommandOrControl`
 *    is the one modifier that accepts either side, and it is only a default —
 *    a chord the user records is stored as the keys they actually pressed, so
 *    rebinding dictation off ⌘P cannot quietly hand Ctrl+P back to readline.
 * 2. **Shift is exact for letters, digits and named keys, ignored for
 *    punctuation.** On most layouts the punctuation itself needs Shift to type,
 *    so demanding an exact Shift state makes those bindings unreachable — ⌘+
 *    and ⌘= are the same request, and both zoom the terminal.
 * 3. **With Option down the physical key counts too.** macOS puts the character
 *    Option *types* into `event.key`, so ⌥⌘K arrives as `˚`; `event.code` is
 *    read to recover the K. Only under Option — `code` ignores the layout, so
 *    reading it always would fire the wrong binding on Dvorak or AZERTY.
 */

export type KeybindId =
  | 'tools.toggle'
  | 'sidebar.collapse'
  | 'explorer.collapse'
  | 'app.settings'
  | 'session.run'
  | 'chat.dictate'
  | 'find.open'
  | 'editor.save'
  | 'terminal.zoomIn'
  | 'terminal.zoomOut'
  | 'terminal.zoomReset'
  | 'voice.capture'

/**
 * `app` bindings are window listeners and only fire while Chewo has focus.
 * `system` is a `globalShortcut` registration — it fires from any app, and it
 * can fail at register time if something else already holds the chord.
 */
export type KeybindScope = 'app' | 'system'

export interface KeybindDef {
  id: KeybindId
  label: string
  /** Shown under the label in the settings row */
  detail: string
  group: string
  scope: KeybindScope
  default: string
}

export const KEYBINDS: KeybindDef[] = [
  {
    id: 'tools.toggle',
    label: 'Toggle the tools panel',
    detail: 'Opens whichever tool was last open — Files, Git or Shell. Code workflow only.',
    group: 'Workspace',
    scope: 'app',
    default: 'CommandOrControl+Shift+E'
  },
  {
    id: 'sidebar.collapse',
    label: 'Collapse the sidebar',
    detail: 'Folds the project rail to a column of workflow icons. Works in every workflow.',
    group: 'Workspace',
    scope: 'app',
    default: 'CommandOrControl+B'
  },
  {
    id: 'explorer.collapse',
    label: 'Collapse the file explorer',
    detail: 'Folds the tree to the edge while the Files tool stays open.',
    group: 'Workspace',
    scope: 'app',
    default: 'CommandOrControl+Shift+B'
  },
  {
    id: 'app.settings',
    label: 'Open settings',
    detail: 'This window.',
    group: 'Workspace',
    scope: 'app',
    default: 'CommandOrControl+,'
  },
  {
    id: 'session.run',
    label: 'Run the start command',
    detail: "Opens a shell in the focused session's checkout and runs its start command.",
    group: 'Session',
    scope: 'app',
    default: 'CommandOrControl+Shift+P'
  },
  {
    id: 'chat.dictate',
    label: 'Dictate a message',
    detail:
      "Toggles the mic in the focused composer. Bound to ⌘ alone by default — Ctrl+P is readline's previous-command in every terminal pane.",
    group: 'Session',
    scope: 'app',
    default: 'Command+P'
  },
  {
    id: 'find.open',
    label: 'Find',
    detail: 'Searches the focused conversation, or the file open in the editor.',
    group: 'Session',
    scope: 'app',
    default: 'CommandOrControl+F'
  },
  {
    id: 'editor.save',
    label: 'Save the file',
    detail: 'In the file editor.',
    group: 'Editing',
    scope: 'app',
    default: 'CommandOrControl+S'
  },
  {
    id: 'terminal.zoomIn',
    label: 'Bigger terminal text',
    detail: 'Font size of the focused terminal only.',
    group: 'Terminal',
    scope: 'app',
    default: 'CommandOrControl+Plus'
  },
  {
    id: 'terminal.zoomOut',
    label: 'Smaller terminal text',
    detail: 'Font size of the focused terminal only.',
    group: 'Terminal',
    scope: 'app',
    default: 'CommandOrControl+-'
  },
  {
    id: 'terminal.zoomReset',
    label: 'Reset terminal text size',
    detail: 'Back to the default font size.',
    group: 'Terminal',
    scope: 'app',
    default: 'CommandOrControl+0'
  },
  {
    id: 'voice.capture',
    label: 'Voice command capture',
    detail:
      'Starts and stops dictating a to-do command. Works from any app, so the chord has to be one no other app needs while Chewo runs.',
    group: 'Voice',
    scope: 'system',
    default: 'Command+.'
  }
]

const BY_ID = new Map<KeybindId, KeybindDef>(KEYBINDS.map((k) => [k.id, k]))

export const keybindDef = (id: KeybindId): KeybindDef => {
  const def = BY_ID.get(id)
  if (!def) throw new Error(`Unknown keybind: ${id}`)
  return def
}

export type KeybindMap = Record<KeybindId, string>

export const DEFAULT_KEYBINDS: KeybindMap = Object.fromEntries(
  KEYBINDS.map((k) => [k.id, k.default])
) as KeybindMap

/**
 * Keys the app reads but does not let you rebind: they are interface behaviour
 * rather than shortcuts the app picked, or they are the clipboard conventions
 * every other Mac app uses. Listed in settings so the Keybinds pane is the
 * whole answer to "what does this key do here", not half of it.
 */
export interface FixedKeyGroup {
  group: string
  rows: Array<{ keys: string; label: string }>
}

export const FIXED_KEYS: FixedKeyGroup[] = [
  {
    group: 'Everywhere',
    rows: [
      { keys: '⎋', label: 'Interrupt the agent, or close the find bar, a menu, a dialog' },
      { keys: '⏎', label: 'Send the message, confirm a dialog, commit a rename' },
      { keys: '⇧⏎', label: 'Newline in the composer' },
      { keys: '↑ ↓', label: 'Move through a picker or a menu' }
    ]
  },
  {
    group: 'Composer',
    rows: [
      { keys: '⇥', label: 'Accept the highlighted slash command or @-file' },
      { keys: '⎋', label: 'Stop dictating, while the mic is open' }
    ]
  },
  {
    group: 'Editor',
    rows: [
      { keys: '⌘G', label: 'Next match (⇧⌘G for the previous one)' },
      { keys: '⌘⌥G', label: 'Go to line' },
      { keys: '⌘D', label: 'Select the next occurrence of the selection' }
    ]
  },
  {
    group: 'Files and notes',
    rows: [
      { keys: '⌘C ⌘X ⌘V', label: 'Copy, cut and paste the selected file' },
      { keys: '⌘⌫ ⌦', label: 'Move the selected file to Trash' },
      { keys: '⏎', label: 'Rename the selected file inline' },
      { keys: '⌘-click', label: 'Open the path under the cursor in the editor' }
    ]
  }
]

// ---------- accelerator parsing ----------

interface Parsed {
  /** Matches either ⌘ or Ctrl — only ever comes from a shipped default */
  cmdOrCtrl: boolean
  command: boolean
  control: boolean
  alt: boolean
  shift: boolean
  /** Normalized to the same vocabulary `normalizeEventKey` produces */
  key: string
}

/** Electron's spellings, plus the shifted characters that share a physical key. */
const KEY_ALIASES: Record<string, string> = {
  plus: '=',
  '+': '=',
  _: '-',
  esc: 'escape',
  return: 'enter',
  ' ': 'space',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  '<': ',',
  '>': '.',
  '?': '/',
  ':': ';',
  '"': "'",
  '~': '`',
  '{': '[',
  '}': ']',
  '|': '\\'
}

const normalizeKey = (raw: string): string => {
  const lower = raw.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/** Punctuation is shift-insensitive — see the rule in the file comment. */
const isPunctuation = (key: string): boolean => key.length === 1 && !/[a-z0-9]/.test(key)

export function parseKeybind(accelerator: string): Parsed | null {
  // "Ctrl++" ends in the plus key; "Ctrl+" ends in nothing and is malformed
  const src = accelerator.endsWith('++') ? `${accelerator.slice(0, -2)}+Plus` : accelerator
  const parts = src
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (parts.length === 0) return null

  const parsed: Parsed = {
    cmdOrCtrl: false,
    command: false,
    control: false,
    alt: false,
    shift: false,
    key: ''
  }
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        parsed.cmdOrCtrl = true
        break
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        parsed.command = true
        break
      case 'control':
      case 'ctrl':
        parsed.control = true
        break
      case 'alt':
      case 'option':
        parsed.alt = true
        break
      case 'shift':
        parsed.shift = true
        break
      default:
        // Two non-modifier tokens is not a chord we can match
        if (parsed.key) return null
        parsed.key = normalizeKey(part)
    }
  }
  return parsed.key ? parsed : null
}

/** What a DOM `KeyboardEvent.key` becomes before it is compared. */
export function normalizeEventKey(key: string): string {
  if (key === ' ') return 'space'
  return normalizeKey(key)
}

/** The parts of a keyboard event the matcher reads — structural, so tests need no DOM. */
export interface KeyChord {
  key: string
  /** `KeyboardEvent.code` — the physical key, needed whenever Option is held */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The physical key behind a `KeyboardEvent.code`, or null for a code we have no
 * name for. Only consulted when Option is held: macOS substitutes the character
 * Option *types* into `event.key`, so ⌥⌘K arrives as `˚` and a chord recorded
 * from it would read `Command+Alt+˚` — unregisterable by `globalShortcut` and
 * meaningless on a button.
 */
const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/'
}

export function physicalKey(code: string | undefined): string | null {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase()
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Space'].includes(code))
    return code.toLowerCase()
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code.toLowerCase()
  return null
}

/**
 * Every token a press could reasonably mean. Normally just the character, but
 * with Option down the physical key is added, since that is the one the user
 * thinks they pressed.
 */
const eventKeys = (event: KeyChord): string[] => {
  const keys = [normalizeEventKey(event.key)]
  if (event.altKey) {
    const physical = physicalKey(event.code)
    if (physical && !keys.includes(physical)) keys.push(physical)
  }
  return keys
}

export function matchesKeybind(event: KeyChord, accelerator: string): boolean {
  const want = parseKeybind(accelerator)
  if (!want) return false
  if (!eventKeys(event).includes(want.key)) return false

  if (want.cmdOrCtrl) {
    if (!event.metaKey && !event.ctrlKey) return false
  } else {
    if (event.metaKey !== want.command) return false
    if (event.ctrlKey !== want.control) return false
  }
  if (event.altKey !== want.alt) return false
  if (isPunctuation(want.key)) return true
  return event.shiftKey === want.shift
}

/**
 * What a press means to the recorder. `null` is "still waiting" — a modifier on
 * its own is half a chord, not a mistake, so the pane says nothing and keeps
 * listening. A refusal carries the sentence to show, because a recorder that
 * ignores a keypress in silence looks broken; that was the whole of the first
 * bug report on this pane.
 */
export type RecordedChord = { ok: true; accelerator: string } | { ok: false; reason: string } | null

/** Keys that are a shortcut on their own — they type nothing, so binding them steals nothing. */
const BARE_KEYS = /^f\d{1,2}$/

const MODIFIER_KEYS = ['meta', 'control', 'alt', 'shift', 'capslock', 'dead', 'unidentified']

/**
 * Read a chord from a key the user just pressed.
 *
 * ⌘ and Ctrl are recorded literally rather than as `CommandOrControl`: the user
 * pressed one of them, and collapsing the two is how a rebind would hand Ctrl+P
 * back to readline behind their back. With Option down the **physical** key is
 * recorded rather than the character Option types, or ⌥⌘K would be stored as
 * `Command+Alt+˚` — which `globalShortcut` cannot register and no one can read.
 */
export function recordChord(event: KeyChord): RecordedChord {
  const typed = normalizeEventKey(event.key)
  if (MODIFIER_KEYS.includes(typed)) return null

  const physical = event.altKey ? physicalKey(event.code) : null
  const key = physical ?? typed

  if (!event.metaKey && !event.ctrlKey && !event.altKey && !BARE_KEYS.test(key)) {
    return {
      ok: false,
      reason: 'Hold ⌘, ⌃ or ⌥ as part of the chord — a bare key would type instead of running a command.'
    }
  }

  const parts: string[] = []
  if (event.metaKey) parts.push('Command')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey && !isPunctuation(key)) parts.push('Shift')
  parts.push(accelKeyToken(key))
  return { ok: true, accelerator: parts.join('+') }
}

/** The token Electron wants for a normalized key. */
function accelKeyToken(key: string): string {
  if (BARE_KEYS.test(key)) return key.toUpperCase()
  if (key === '=') return 'Plus'
  if (key === 'space') return 'Space'
  if (key === 'escape') return 'Esc'
  if (key === 'enter') return 'Return'
  if (key.startsWith('arrow')) {
    const dir = key.slice(5)
    return dir.charAt(0).toUpperCase() + dir.slice(1)
  }
  if (key.length === 1) return key.toUpperCase()
  return key.charAt(0).toUpperCase() + key.slice(1)
}

// ---------- display ----------

const GLYPHS: Record<string, string> = {
  '=': '+',
  space: '␣',
  escape: '⎋',
  enter: '⏎',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→'
}

/**
 * Mac glyphs unconditionally — Chewo is a macOS app, and a shortcut hint that
 * says "Ctrl+Shift+E" on a machine whose keyboard says ⌘ is worse than wrong.
 */
export function formatKeybind(accelerator: string): string {
  const parsed = parseKeybind(accelerator)
  if (!parsed) return accelerator
  let out = ''
  if (parsed.control) out += '⌃'
  if (parsed.alt) out += '⌥'
  if (parsed.shift) out += '⇧'
  if (parsed.cmdOrCtrl || parsed.command) out += '⌘'
  const named = BARE_KEYS.test(parsed.key) ? parsed.key.toUpperCase() : parsed.key
  const key = GLYPHS[parsed.key] ?? (named.length === 1 ? named.toUpperCase() : named)
  return out + key
}

/**
 * The same binding in CodeMirror's key notation ("Mod-s"), for the two places
 * the editor owns its own keymap. `Mod` is CodeMirror's own either-side
 * modifier, so it lines up with `CommandOrControl` exactly.
 */
export function toCodeMirrorKey(accelerator: string): string | null {
  const parsed = parseKeybind(accelerator)
  if (!parsed) return null
  const parts: string[] = []
  if (parsed.cmdOrCtrl) parts.push('Mod')
  if (parsed.command) parts.push('Cmd')
  if (parsed.control) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(CM_KEYS[parsed.key] ?? (BARE_KEYS.test(parsed.key) ? parsed.key.toUpperCase() : parsed.key))
  return parts.join('-')
}

const CM_KEYS: Record<string, string> = {
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
}

// ---------- conflicts ----------

const modifiersOverlap = (a: Parsed, b: Parsed): boolean => {
  if (a.alt !== b.alt) return false
  if (!isPunctuation(a.key) && a.shift !== b.shift) return false
  const aMeta = a.cmdOrCtrl || a.command
  const bMeta = b.cmdOrCtrl || b.command
  const aCtrl = a.cmdOrCtrl || a.control
  const bCtrl = b.cmdOrCtrl || b.control
  // Two chords collide if there is any keypress that satisfies both
  return (aMeta && bMeta) || (aCtrl && bCtrl) || (!aMeta && !aCtrl && !bMeta && !bCtrl)
}

/**
 * The command already holding `accelerator`, or null. Scopes are checked apart:
 * a system-wide chord is registered with the OS and never reaches a window
 * listener, so it cannot collide with one.
 */
export function findConflict(
  map: KeybindMap,
  id: KeybindId,
  accelerator: string
): KeybindId | null {
  const want = parseKeybind(accelerator)
  if (!want) return null
  const scope = keybindDef(id).scope
  for (const def of KEYBINDS) {
    if (def.id === id || def.scope !== scope) continue
    const other = parseKeybind(map[def.id])
    if (!other) continue
    if (other.key === want.key && modifiersOverlap(want, other)) return def.id
  }
  return null
}

// ---------- persistence ----------

/**
 * Overrides merged over the shipped defaults, so a settings.json written before
 * a new shortcut existed picks it up — the same rule appearance follows.
 * `legacyHotkey` is the old `todoHotkey` from projects.json, adopted once when
 * the user has not set a voice binding here yet.
 */
export function normalizeKeybinds(value: unknown, legacyHotkey?: string): KeybindMap {
  const saved = (value ?? {}) as Partial<Record<KeybindId, unknown>>
  const map = { ...DEFAULT_KEYBINDS }
  for (const def of KEYBINDS) {
    const raw = saved[def.id]
    if (typeof raw === 'string' && parseKeybind(raw)) map[def.id] = raw
  }
  if (
    typeof saved['voice.capture'] !== 'string' &&
    legacyHotkey &&
    parseKeybind(legacyHotkey)
  )
    map['voice.capture'] = legacyHotkey
  return map
}
