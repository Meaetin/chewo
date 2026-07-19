// User-customisable appearance settings. Dependency-free so the main process
// can read them at window creation (native background color) while the
// renderer derives CSS variables, the xterm theme, and the CodeMirror theme
// from the same values. Defaults mirror the primitives in styles.css.

export interface TerminalAnsiColors {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface EditorSyntaxColors {
  keyword: string
  string: string
  number: string
  function: string
  type: string
  tag: string
  attribute: string
  property: string
  punctuation: string
  comment: string
  regexp: string
  link: string
  invalid: string
}

/** Markdown render accents for the notes lesson preview (scoped to notes only) */
export interface NotesColors {
  heading: string
  link: string
  /** Inline code text */
  code: string
  /** Blockquote text + left border */
  quote: string
}

export interface AppearanceSettings {
  /** Surface-0 — the whole neutral surface ramp is derived from this */
  base: string
  /** Primary accent — drives the accent scale, cursors, selection, focus */
  accent: string
  /** Secondary accent — expanded project/section highlight (periwinkle) */
  accentSecondary: string
  /** Tertiary accent — live/running indicator (cyan) */
  accentTertiary: string
  terminal: TerminalAnsiColors
  editor: EditorSyntaxColors
  notes: NotesColors
}

/** userData/settings.json — appearance today, room for future tabs */
export interface SettingsFile {
  appearance: AppearanceSettings
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  base: '#141414', // --c-surface-0 (graphite)
  accent: '#3bbf8b', // --c-accent (emerald)
  accentSecondary: '#948ada', // --c-project (periwinkle)
  accentTertiary: '#34c9d6', // --c-live (cyan)
  terminal: {
    black: '#232323',
    red: '#e2574b',
    green: '#79b36a',
    yellow: '#dfa94e',
    blue: '#6ba4f8',
    magenta: '#c98aa9',
    cyan: '#34c9d6',
    white: '#d8d5d0',
    brightBlack: '#5a5a5a',
    brightRed: '#ec6c61',
    brightGreen: '#93c586',
    brightYellow: '#e9bc6e',
    brightBlue: '#8fbdfa',
    brightMagenta: '#d6a2bc',
    brightCyan: '#5fd7e2',
    brightWhite: '#f4f1ec'
  },
  editor: {
    keyword: '#b3a7ff',
    string: '#5fd39b',
    number: '#e6b667',
    function: '#83b9ff',
    type: '#5ad4e0',
    tag: '#e79070',
    attribute: '#e6b667',
    property: '#d7d3ea',
    punctuation: '#adaaa6',
    comment: '#8a8781',
    regexp: '#ef8a80',
    link: '#83b9ff',
    invalid: '#e2574b'
  },
  notes: {
    heading: '#4ccf9b', // emerald — lesson headings pop, on-theme
    link: '#3bbf8b', // accent
    code: '#5fd39b', // soft green — inline code reads as code
    quote: '#807d78' // text-tertiary — quiet blockquotes
  }
}

// ---------- color math ----------

/** '#rgb' or '#rrggbb' → [r, g, b] 0-255; null when malformed */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Normalise to lowercase '#rrggbb'; null when not a hex color */
export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** h 0-360, s/l 0-100 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r8, g8, b8] = hexToRgb(hex) ?? [20, 20, 20]
  const r = r8 / 255
  const g = g8 / 255
  const b = b8 / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 1000) / 10 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 1000) / 10,
    l: Math.round(l * 1000) / 10
  }
}

/** h 0-360, s/l 0-100 → '#rrggbb' */
export function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = sn * Math.min(ln, 1 - ln)
  const f = (n: number): number => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const to = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

/** '#rrggbb' + alpha → 'rgba(r, g, b, a)' */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex) ?? [0, 0, 0]
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Linear blend a→b in RGB; t=0 → a, t=1 → b */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a) ?? [0, 0, 0]
  const cb = hexToRgb(b) ?? [0, 0, 0]
  const to = (v: number): string => Math.round(v).toString(16).padStart(2, '0')
  return '#' + ca.map((v, i) => to(v + (cb[i] - v) * t)).join('')
}

export interface SurfaceRamp {
  /** surface-0 … surface-5 (window → pressed) */
  surfaces: [string, string, string, string, string, string]
  /** hairlines / dividers */
  line1: string
  /** input & overlay borders */
  line2: string
}

// Lightness offsets of the stock graphite ramp relative to surface-0
// (#141414 → #181818 → #1e1e1e → #252525 → #2c2c2c → #343434 / #3a3a3a #484848)
const SURFACE_OFFSETS = [0, 1.6, 3.9, 6.7, 9.4, 12.6] as const
const LINE_OFFSETS = [14.9, 20.4] as const

/** Rebuild the whole neutral ramp from one base color, keeping its hue/chroma */
export function deriveSurfaces(base: string): SurfaceRamp {
  const { h, s, l } = hexToHsl(base)
  const at = (offset: number): string => hslToHex(h, s, Math.min(100, Math.max(0, l + offset)))
  return {
    surfaces: SURFACE_OFFSETS.map(at) as SurfaceRamp['surfaces'],
    line1: at(LINE_OFFSETS[0]),
    line2: at(LINE_OFFSETS[1])
  }
}

export interface TextRamp {
  primary: string
  secondary: string
  tertiary: string
  faint: string
}

// The stock cream ramp (--c-text-primary…faint) with a per-level saturation cap
// so text carries only a whisper of hue. These are the anchors: a neutral base
// reproduces them exactly; a saturated base pulls each toward the base hue.
const TEXT_ANCHORS = [
  { hex: '#e9e7e4', sCap: 16 },
  { hex: '#adaaa6', sCap: 11 },
  { hex: '#807d78', sCap: 8 },
  { hex: '#5a5854', sCap: 6 }
] as const

// Base saturation at which text/rim fully adopt the base hue; below it the
// stock cream shows through proportionally (so the default look is preserved).
const HUE_PULL_FULL_AT = 40

/**
 * Text ramp that tracks the base hue. At a neutral base it is exactly the stock
 * cream; as the base gains saturation the whole ramp is pulled toward its hue,
 * fully by ~40% saturation.
 */
export function deriveTextRamp(base: string): TextRamp {
  const { h, s } = hexToHsl(base)
  const pull = Math.min(1, s / HUE_PULL_FULL_AT)
  const [primary, secondary, tertiary, faint] = TEXT_ANCHORS.map((a) => {
    const tint = hslToHex(h, Math.min(s, a.sCap), hexToHsl(a.hex).l)
    return mixHex(a.hex, tint, pull)
  })
  return { primary, secondary, tertiary, faint }
}

/** Inset top rim-light: white by default, pulled toward the base hue when set */
export function deriveRim(base: string): string {
  const { h, s } = hexToHsl(base)
  const pull = Math.min(1, s / HUE_PULL_FULL_AT)
  return withAlpha(mixHex('#ffffff', hslToHex(h, Math.min(s, 20), 92), pull), 0.05)
}
