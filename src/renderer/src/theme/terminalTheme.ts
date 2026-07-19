import type { ITheme } from '@xterm/xterm'
import {
  deriveSurfaces,
  deriveTextRamp,
  withAlpha,
  type AppearanceSettings
} from '../../../shared/appearance'

// xterm mono stack — mirrors --font-mono in styles.css (JS can't read the CSS var).
export const MONO_STACK = "'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace"

/**
 * ANSI-16 xterm theme from the user's appearance settings. The canvas
 * (surface-1) is derived from the base so the terminal shares its background
 * with the editor; cursor + selection follow the primary accent. Defaults
 * (design/06): ANSI green is deliberately a distinct yellow-green so it never
 * blurs into the accent-colored cursor.
 */
export function makeTerminalTheme(a: AppearanceSettings): ITheme {
  const canvas = deriveSurfaces(a.base).surfaces[1]
  return {
    background: canvas,
    foreground: deriveTextRamp(a.base).primary,
    cursor: a.accent,
    cursorAccent: canvas,
    selectionBackground: withAlpha(a.accent, 0.25),
    ...a.terminal
  }
}
