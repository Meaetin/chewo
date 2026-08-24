// Curated theme presets + palettes for the Appearance settings. Dependency-free
// (types only from appearance.ts) so it can be imported anywhere. Every preset is
// a full AppearanceSettings for fidelity; the surface ramp, text ramp and rim are
// derived from `base` at apply time (see applyAppearance / makeTerminalTheme).
//
// The three accents are three *signals*, not a colour harmony: `accent` means
// you-are-here, `accentSecondary` means this-container-is-open (the expanded
// project's wash and left bar), `accentTertiary` means an-agent-is-working
// (every live dot, running row and in-flight tool chip). Picking all three out
// of one palette family makes them neighbours and destroys the distinction, so
// each preset keeps them **at least 45° apart in hue** and clear of the hues
// the fixed status colours already own — danger (h5), the Claude badge (h17),
// warning (h38), diff-add (h135) and the Codex badge (h214). That leaves three
// usable bands: 64–109, 161–188 and 240–339. `tests/appearance.test.ts` pins
// all of it, so a new preset cannot quietly reintroduce the problem.

import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type EditorSyntaxColors,
  type NotesColors,
  type TerminalAnsiColors
} from './appearance'

export interface ThemePreset {
  id: string
  name: string
  description: string
  appearance: AppearanceSettings
}

export const PRESETS: ThemePreset[] = [
  {
    id: 'graphite-emerald',
    name: 'Graphite Emerald',
    description: 'Neutral graphite base, emerald accent — the Chewo default.',
    appearance: DEFAULT_APPEARANCE
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep navy base, bright sky accent, indigo and pink signals.',
    appearance: {
      base: '#0f1420',
      accent: '#38bdf8',
      accentSecondary: '#8b7ff5',
      accentTertiary: '#f472b6',
      terminal: {
        black: '#1e293b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#cbd5e1',
        brightBlack: '#475569',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f1f5f9'
      },
      editor: {
        keyword: '#c084fc',
        string: '#4ade80',
        number: '#fbbf24',
        function: '#60a5fa',
        type: '#22d3ee',
        tag: '#f472b6',
        attribute: '#fbbf24',
        property: '#cbd5e1',
        punctuation: '#94a3b8',
        comment: '#64748b',
        regexp: '#f87171',
        link: '#60a5fa',
        invalid: '#f87171'
      },
      notes: { heading: '#38bdf8', link: '#38bdf8', code: '#4ade80', quote: '#64748b' }
    }
  },
  {
    id: 'nocturne',
    name: 'Nocturne',
    description: 'Nord — cool blue-grey base, frost accent, mauve and sage signals.',
    appearance: {
      base: '#2e3440',
      accent: '#88c0d0',
      accentSecondary: '#c89dc0',
      accentTertiary: '#a3be8c',
      terminal: {
        black: '#3b4252',
        red: '#bf616a',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        blue: '#81a1c1',
        magenta: '#b48ead',
        cyan: '#88c0d0',
        white: '#e5e9f0',
        brightBlack: '#4c566a',
        brightRed: '#d08770',
        brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1',
        brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb',
        brightWhite: '#eceff4'
      },
      editor: {
        keyword: '#81a1c1',
        string: '#a3be8c',
        number: '#b48ead',
        function: '#88c0d0',
        type: '#8fbcbb',
        tag: '#81a1c1',
        attribute: '#8fbcbb',
        property: '#d8dee9',
        punctuation: '#abb2bf',
        comment: '#616e88',
        regexp: '#ebcb8b',
        link: '#88c0d0',
        invalid: '#bf616a'
      },
      notes: { heading: '#88c0d0', link: '#88c0d0', code: '#a3be8c', quote: '#616e88' }
    }
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Gruvbox — warm charcoal base, amber accent, teal and pink signals.',
    appearance: {
      base: '#1d2021',
      accent: '#fabd2f',
      accentSecondary: '#78b7ba',
      accentTertiary: '#cf7bb0',
      terminal: {
        black: '#282828',
        red: '#cc241d',
        green: '#98971a',
        yellow: '#d79921',
        blue: '#458588',
        magenta: '#b16286',
        cyan: '#689d6a',
        white: '#a89984',
        brightBlack: '#928374',
        brightRed: '#fb4934',
        brightGreen: '#b8bb26',
        brightYellow: '#fabd2f',
        brightBlue: '#83a598',
        brightMagenta: '#d3869b',
        brightCyan: '#8ec07c',
        brightWhite: '#ebdbb2'
      },
      editor: {
        keyword: '#fb4934',
        string: '#b8bb26',
        number: '#d3869b',
        function: '#fabd2f',
        type: '#8ec07c',
        tag: '#fb4934',
        attribute: '#fabd2f',
        property: '#ebdbb2',
        punctuation: '#a89984',
        comment: '#928374',
        regexp: '#fe8019',
        link: '#83a598',
        invalid: '#fb4934'
      },
      notes: { heading: '#fabd2f', link: '#fabd2f', code: '#b8bb26', quote: '#928374' }
    }
  },
  {
    id: 'nightshade',
    name: 'Nightshade',
    description: 'Dracula — violet base, pink accent, purple and turquoise signals.',
    appearance: {
      base: '#282a36',
      accent: '#ff79c6',
      accentSecondary: '#bd93f9',
      accentTertiary: '#5ce6d2',
      terminal: {
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff'
      },
      editor: {
        keyword: '#ff79c6',
        string: '#f1fa8c',
        number: '#bd93f9',
        function: '#50fa7b',
        type: '#8be9fd',
        tag: '#ff79c6',
        attribute: '#50fa7b',
        property: '#f8f8f2',
        punctuation: '#f8f8f2',
        comment: '#6272a4',
        regexp: '#ff5555',
        link: '#8be9fd',
        invalid: '#ff5555'
      },
      notes: { heading: '#ff79c6', link: '#8be9fd', code: '#50fa7b', quote: '#6272a4' }
    }
  },
  {
    id: 'rose',
    name: 'Rosé',
    description: 'Rosé Pine — muted mauve base with rose, iris and foam.',
    appearance: {
      base: '#191724',
      accent: '#ebbcba',
      accentSecondary: '#c4a7e7',
      accentTertiary: '#86cdd8',
      terminal: {
        black: '#26233a',
        red: '#eb6f92',
        green: '#31748f',
        yellow: '#f6c177',
        blue: '#9ccfd8',
        magenta: '#c4a7e7',
        cyan: '#ebbcba',
        white: '#e0def4',
        brightBlack: '#6e6a86',
        brightRed: '#eb6f92',
        brightGreen: '#31748f',
        brightYellow: '#f6c177',
        brightBlue: '#9ccfd8',
        brightMagenta: '#c4a7e7',
        brightCyan: '#ebbcba',
        brightWhite: '#e0def4'
      },
      editor: {
        keyword: '#c4a7e7',
        string: '#f6c177',
        number: '#eb6f92',
        function: '#ebbcba',
        type: '#9ccfd8',
        tag: '#31748f',
        attribute: '#f6c177',
        property: '#e0def4',
        punctuation: '#908caa',
        comment: '#6e6a86',
        regexp: '#eb6f92',
        link: '#9ccfd8',
        invalid: '#eb6f92'
      },
      notes: { heading: '#ebbcba', link: '#9ccfd8', code: '#f6c177', quote: '#6e6a86' }
    }
  },
  // GitHub Light, kept byte for byte: every one of its slots already clears
  // 3:1 against a white canvas. Pastel light palettes (Catppuccin Latte,
  // Solarized Light) were tried and dropped — several of their own colours sit
  // under that bar on their own paper, and darkening them enough to read is a
  // different theme wearing their name.
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'White canvas, GitHub Light syntax and ANSI — the plainest light theme.',
    appearance: {
      base: '#ffffff',
      accent: '#0969da',
      accentSecondary: '#8250df',
      accentTertiary: '#bf3989',
      terminal: {
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d2d00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f'
      },
      editor: {
        keyword: '#cf222e',
        string: '#0a3069',
        number: '#0550ae',
        function: '#8250df',
        type: '#953800',
        tag: '#116329',
        attribute: '#0550ae',
        property: '#1f2328',
        punctuation: '#57606a',
        comment: '#6e7781',
        regexp: '#0a3069',
        link: '#0969da',
        invalid: '#82071e'
      },
      notes: { heading: '#0550ae', link: '#0969da', code: '#116329', quote: '#6e7781' }
    }
  }
]

// Quick-pick swatches for the high-impact slots. Bases run dark to light —
// anything past 55% lightness flips the whole app into light mode (see
// isLightBase), so these last two are the way into one by hand. Accents are
// saturated hues that read as the app accent at either end of the ramp.
export const CURATED_BASES = [
  '#141414', // graphite
  '#0a0a0a', // true black
  '#0f1420', // navy
  '#1a1613', // warm charcoal
  '#14181f', // cool slate
  '#191724', // plum
  '#101613', // forest
  '#2e3440', // nord grey
  '#ffffff', // paper white
  '#f4f5f7' // cool paper
]

export const CURATED_ACCENTS = [
  '#3bbf8b', // emerald
  '#14b8a6', // teal
  '#22d3ee', // cyan
  '#38bdf8', // sky
  '#60a5fa', // blue
  '#818cf8', // indigo
  '#a78bfa', // violet
  '#ec4899', // pink
  '#fb7185', // rose
  '#f59e0b', // amber
  '#84cc16', // lime
  '#fb923c', // orange
  '#0969da', // deep blue — for light bases
  '#8250df', // deep violet
  '#116329', // deep green
  '#b8532e' // deep terracotta
]

/** Every AppearanceSettings field, for structural comparison */
function appearanceEqual(a: AppearanceSettings, b: AppearanceSettings): boolean {
  if (
    a.base !== b.base ||
    a.accent !== b.accent ||
    a.accentSecondary !== b.accentSecondary ||
    a.accentTertiary !== b.accentTertiary
  )
    return false
  for (const k of Object.keys(a.terminal) as Array<keyof TerminalAnsiColors>)
    if (a.terminal[k] !== b.terminal[k]) return false
  for (const k of Object.keys(a.editor) as Array<keyof EditorSyntaxColors>)
    if (a.editor[k] !== b.editor[k]) return false
  for (const k of Object.keys(a.notes) as Array<keyof NotesColors>)
    if (a.notes[k] !== b.notes[k]) return false
  return true
}

/** id of the preset the current settings exactly match, else null (= "Custom") */
export function matchPreset(a: AppearanceSettings): string | null {
  return PRESETS.find((p) => appearanceEqual(p.appearance, a))?.id ?? null
}
