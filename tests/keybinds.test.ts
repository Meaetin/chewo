import { describe, expect, test } from 'vitest'
import {
  DEFAULT_KEYBINDS,
  KEYBINDS,
  findConflict,
  formatKeybind,
  matchesKeybind,
  normalizeKeybinds,
  parseKeybind,
  recordChord,
  toCodeMirrorKey,
  type KeyChord
} from '../src/shared/keybinds'

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('parseKeybind', () => {
  test('reads modifiers and the key', () => {
    expect(parseKeybind('CommandOrControl+Shift+E')).toEqual({
      cmdOrCtrl: true,
      command: false,
      control: false,
      alt: false,
      shift: true,
      key: 'e'
    })
  })

  test('a trailing plus is the plus key, not an empty modifier', () => {
    expect(parseKeybind('CommandOrControl++')?.key).toBe('=')
  })

  test('rejects a chord with no key, or with two', () => {
    expect(parseKeybind('Command+Shift')).toBeNull()
    expect(parseKeybind('Command+E+F')).toBeNull()
    expect(parseKeybind('')).toBeNull()
  })
})

describe('matchesKeybind', () => {
  test('CommandOrControl takes either side', () => {
    const accel = 'CommandOrControl+Shift+E'
    expect(matchesKeybind(chord('e', { metaKey: true, shiftKey: true }), accel)).toBe(true)
    expect(matchesKeybind(chord('E', { ctrlKey: true, shiftKey: true }), accel)).toBe(true)
    expect(matchesKeybind(chord('e', { shiftKey: true }), accel)).toBe(false)
  })

  test('Command alone refuses Ctrl — Ctrl+P belongs to readline', () => {
    expect(matchesKeybind(chord('p', { metaKey: true }), 'Command+P')).toBe(true)
    expect(matchesKeybind(chord('p', { ctrlKey: true }), 'Command+P')).toBe(false)
  })

  test('modifiers are exact, so dictation does not eat the run shortcut', () => {
    expect(matchesKeybind(chord('p', { metaKey: true, shiftKey: true }), 'Command+P')).toBe(false)
    expect(
      matchesKeybind(chord('p', { metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+P')
    ).toBe(true)
    expect(matchesKeybind(chord('p', { metaKey: true, altKey: true }), 'Command+P')).toBe(false)
  })

  test('shift is ignored for punctuation, so ⌘= and ⌘+ both zoom', () => {
    const accel = DEFAULT_KEYBINDS['terminal.zoomIn']
    expect(matchesKeybind(chord('=', { metaKey: true }), accel)).toBe(true)
    expect(matchesKeybind(chord('+', { metaKey: true, shiftKey: true }), accel)).toBe(true)
  })

  test('the settings comma is not confused with anything else', () => {
    expect(matchesKeybind(chord(',', { metaKey: true }), 'CommandOrControl+,')).toBe(true)
    expect(matchesKeybind(chord('.', { metaKey: true }), 'CommandOrControl+,')).toBe(false)
  })

  test('named keys keep their names', () => {
    expect(matchesKeybind(chord('ArrowUp', { metaKey: true }), 'Command+Up')).toBe(true)
    expect(matchesKeybind(chord(' ', { ctrlKey: true }), 'Control+Space')).toBe(true)
  })
})

describe('recordChord', () => {
  const accel = (c: KeyChord): string | undefined => {
    const r = recordChord(c)
    return r && r.ok ? r.accelerator : undefined
  }
  const refusal = (c: KeyChord): string | undefined => {
    const r = recordChord(c)
    return r && !r.ok ? r.reason : undefined
  }

  test('records the modifiers actually pressed', () => {
    expect(accel(chord('k', { metaKey: true, shiftKey: true }))).toBe('Command+Shift+K')
    expect(accel(chord('j', { ctrlKey: true, altKey: true, code: 'KeyJ' }))).toBe('Control+Alt+J')
  })

  test('a lone modifier is half a chord, so it says nothing and waits', () => {
    expect(recordChord(chord('Meta', { metaKey: true }))).toBeNull()
    expect(recordChord(chord('Shift', { shiftKey: true }))).toBeNull()
    expect(recordChord(chord('Dead', { altKey: true }))).toBeNull()
  })

  test('a bare key is refused out loud rather than ignored', () => {
    expect(refusal(chord('k'))).toMatch(/Hold ⌘/)
    expect(refusal(chord('Enter'))).toMatch(/Hold ⌘/)
    expect(refusal(chord('t', { shiftKey: true }))).toMatch(/Hold ⌘/)
  })

  test('a function key needs no modifier — it types nothing to begin with', () => {
    expect(accel(chord('F5', { code: 'F5' }))).toBe('F5')
    expect(accel(chord('F12', { code: 'F12', shiftKey: true }))).toBe('Shift+F12')
  })

  test('Option records the physical key, not the character Option types', () => {
    // macOS turns ⌥K into ˚; stored as `Command+Alt+˚` it is unregisterable
    expect(accel(chord('˚', { metaKey: true, altKey: true, code: 'KeyK' }))).toBe('Command+Alt+K')
    expect(accel(chord('¡', { altKey: true, code: 'Digit1' }))).toBe('Alt+1')
  })

  test('round-trips through the matcher, Option included', () => {
    for (const pressed of [
      chord('/', { metaKey: true, shiftKey: true, code: 'Slash' }),
      chord('˚', { metaKey: true, altKey: true, code: 'KeyK' }),
      chord('F5', { code: 'F5' })
    ]) {
      const a = accel(pressed)
      expect(a).toBeDefined()
      expect(matchesKeybind(pressed, a as string)).toBe(true)
    }
  })
})

describe('matchesKeybind with Option held', () => {
  test('an Option binding fires on the key the user thinks they pressed', () => {
    const pressed = chord('˚', { metaKey: true, altKey: true, code: 'KeyK' })
    expect(matchesKeybind(pressed, 'Command+Alt+K')).toBe(true)
  })

  test('a chord already stored as the Option character still fires', () => {
    const pressed = chord('˚', { metaKey: true, altKey: true, code: 'KeyK' })
    expect(matchesKeybind(pressed, 'Command+Alt+˚')).toBe(true)
  })

  test('the physical key is only consulted when Option is down', () => {
    // Without Option there is no substitution to undo, and reading the physical
    // key would make a Dvorak or AZERTY layout fire the wrong binding
    expect(matchesKeybind(chord('q', { metaKey: true, code: 'KeyA' }), 'Command+A')).toBe(false)
  })
})

describe('formatKeybind', () => {
  test('function keys keep their case', () => {
    expect(formatKeybind('F5')).toBe('F5')
    expect(formatKeybind('Command+Alt+F12')).toBe('⌥⌘F12')
    expect(toCodeMirrorKey('Shift+F5')).toBe('Shift-F5')
  })

  test('mac glyphs, in the mac order', () => {
    expect(formatKeybind('CommandOrControl+Shift+E')).toBe('⇧⌘E')
    expect(formatKeybind('Command+P')).toBe('⌘P')
    expect(formatKeybind('CommandOrControl+,')).toBe('⌘,')
    expect(formatKeybind('Command+.')).toBe('⌘.')
    expect(formatKeybind('CommandOrControl+Plus')).toBe('⌘+')
    expect(formatKeybind('Control+Alt+Space')).toBe('⌃⌥␣')
  })

  test('an unparseable string is shown as written rather than swallowed', () => {
    expect(formatKeybind('Command+Shift')).toBe('Command+Shift')
  })
})

describe('toCodeMirrorKey', () => {
  test('Mod is CodeMirror\'s CommandOrControl', () => {
    expect(toCodeMirrorKey('CommandOrControl+S')).toBe('Mod-s')
    expect(toCodeMirrorKey('CommandOrControl+F')).toBe('Mod-f')
    expect(toCodeMirrorKey('Command+Shift+F')).toBe('Cmd-Shift-f')
    expect(toCodeMirrorKey('Control+Alt+Enter')).toBe('Ctrl-Alt-Enter')
  })

  test('an unreadable accelerator gives null rather than a broken binding', () => {
    expect(toCodeMirrorKey('Command+Shift')).toBeNull()
  })
})

describe('findConflict', () => {
  test('names the command already holding the chord', () => {
    expect(findConflict(DEFAULT_KEYBINDS, 'find.open', 'CommandOrControl+Shift+E')).toBe(
      'tools.toggle'
    )
  })

  test('CommandOrControl collides with both of its halves', () => {
    expect(findConflict(DEFAULT_KEYBINDS, 'find.open', 'Command+Shift+E')).toBe('tools.toggle')
    expect(findConflict(DEFAULT_KEYBINDS, 'find.open', 'Control+Shift+E')).toBe('tools.toggle')
  })

  test('⌘P and ⌘⇧P coexist, and a command never conflicts with itself', () => {
    expect(findConflict(DEFAULT_KEYBINDS, 'chat.dictate', 'Command+P')).toBeNull()
    expect(findConflict(DEFAULT_KEYBINDS, 'find.open', 'Command+P')).toBe('chat.dictate')
    expect(findConflict(DEFAULT_KEYBINDS, 'find.open', 'CommandOrControl+Shift+P')).toBe(
      'session.run'
    )
  })

  test('the system-wide hotkey is checked apart from the window listeners', () => {
    expect(findConflict(DEFAULT_KEYBINDS, 'voice.capture', 'CommandOrControl+Shift+E')).toBeNull()
  })

  test('no two shipped defaults collide', () => {
    for (const def of KEYBINDS) {
      expect(findConflict(DEFAULT_KEYBINDS, def.id, def.default)).toBeNull()
    }
  })
})

describe('normalizeKeybinds', () => {
  test('missing and unreadable entries fall back to the default', () => {
    const map = normalizeKeybinds({ 'tools.toggle': 'Command+J', 'find.open': 42, bogus: 'x' })
    expect(map['tools.toggle']).toBe('Command+J')
    expect(map['find.open']).toBe(DEFAULT_KEYBINDS['find.open'])
    expect(map['editor.save']).toBe(DEFAULT_KEYBINDS['editor.save'])
    expect(Object.keys(map).sort()).toEqual(KEYBINDS.map((k) => k.id).sort())
  })

  test('a nonsense accelerator is refused rather than stored', () => {
    expect(normalizeKeybinds({ 'editor.save': 'Command+' })['editor.save']).toBe(
      DEFAULT_KEYBINDS['editor.save']
    )
  })

  test('the old projects.json hotkey is adopted once, then never again', () => {
    expect(normalizeKeybinds(undefined, 'Alt+Space')['voice.capture']).toBe('Alt+Space')
    expect(normalizeKeybinds({ 'voice.capture': 'Command+/' }, 'Alt+Space')['voice.capture']).toBe(
      'Command+/'
    )
  })

  test('undefined settings give the shipped map', () => {
    expect(normalizeKeybinds(undefined)).toEqual(DEFAULT_KEYBINDS)
  })
})
