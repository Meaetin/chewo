// Curated theme presets + palettes for the Appearance settings. Dependency-free
// (types only from appearance.ts) so it can be imported anywhere. Every preset is
// a full AppearanceSettings for fidelity; the surface ramp, text ramp and rim are
// derived from `base` at apply time (see applyAppearance / makeTerminalTheme).

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
    description: 'Deep navy base with a bright sky-cyan accent.',
    appearance: {
      base: '#0f1420',
      accent: '#38bdf8',
      accentSecondary: '#818cf8',
      accentTertiary: '#2dd4bf',
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
    description: 'Cool blue-grey base with soft frost accents.',
    appearance: {
      base: '#2e3440',
      accent: '#88c0d0',
      accentSecondary: '#81a1c1',
      accentTertiary: '#8fbcbb',
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
    description: 'Warm charcoal base, amber accent, mossy greens.',
    appearance: {
      base: '#1d2021',
      accent: '#fabd2f',
      accentSecondary: '#b8bb26',
      accentTertiary: '#8ec07c',
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
    description: 'Violet-tinted base with pink and purple accents.',
    appearance: {
      base: '#282a36',
      accent: '#ff79c6',
      accentSecondary: '#bd93f9',
      accentTertiary: '#8be9fd',
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
    description: 'Muted mauve base with rose, iris and foam accents.',
    appearance: {
      base: '#191724',
      accent: '#ebbcba',
      accentSecondary: '#c4a7e7',
      accentTertiary: '#9ccfd8',
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
  }
]

// Quick-pick swatches for the high-impact slots. Base = dark neutrals/tints;
// accents = saturated hues that read well as the app accent on a dark canvas.
export const CURATED_BASES = [
  '#141414', // graphite
  '#0a0a0a', // true black
  '#0f1420', // navy
  '#1a1613', // warm charcoal
  '#14181f', // cool slate
  '#191724', // plum
  '#101613', // forest
  '#2e3440' // nord grey
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
  '#fb923c' // orange
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
