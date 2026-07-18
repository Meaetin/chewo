// Single source of truth for the two colors JS surfaces need but can't read
// from CSS custom properties (the Electron main-process window and xterm/CodeMirror).
// These MUST mirror the primitives in src/renderer/src/styles.css — change together.
// Kept dependency-free so the main process can import it without pulling in renderer code.

export const WINDOW_BG = '#141414' // --c-surface-0 (window base; resize flashes stay neutral)
export const CANVAS_BG = '#181818' // --c-surface-1 (terminal + editor canvas)
