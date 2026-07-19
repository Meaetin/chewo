import {
  deriveRim,
  deriveSurfaces,
  deriveTextRamp,
  hexToHsl,
  withAlpha,
  type AppearanceSettings
} from '../../../shared/appearance'

/**
 * Push the user's appearance settings into the CSS token system as inline
 * overrides on :root. Only primitives are set — every semantic token in
 * styles.css derives from these, so the whole UI (including the notes
 * markdown preview) re-themes live. The accent is written as its H/S/L parts;
 * the CSS calc() scale (hover / press / text / wash) derives the rest.
 */
export function applyAppearance(a: AppearanceSettings): void {
  const root = document.documentElement.style
  const ramp = deriveSurfaces(a.base)
  ramp.surfaces.forEach((hex, i) => root.setProperty(`--c-surface-${i}`, hex))
  root.setProperty('--c-line-1', ramp.line1)
  root.setProperty('--c-line-2', ramp.line2)

  // Text + rim track the base hue so they stay legible on a tinted base
  const text = deriveTextRamp(a.base)
  root.setProperty('--c-text-primary', text.primary)
  root.setProperty('--c-text-secondary', text.secondary)
  root.setProperty('--c-text-tertiary', text.tertiary)
  root.setProperty('--c-text-faint', text.faint)
  root.setProperty('--c-rim', deriveRim(a.base))

  const { h, s, l } = hexToHsl(a.accent)
  root.setProperty('--accent-h', String(h))
  root.setProperty('--accent-s', `${s}%`)
  root.setProperty('--accent-l', `${l}%`)

  root.setProperty('--c-project', a.accentSecondary)
  root.setProperty('--c-project-wash', withAlpha(a.accentSecondary, 0.16))
  root.setProperty('--c-live', a.accentTertiary)
  root.setProperty('--c-live-wash', withAlpha(a.accentTertiary, 0.12))

  // Notes markdown render accents — consumed only by .notes-md-preview
  root.setProperty('--notes-heading', a.notes.heading)
  root.setProperty('--notes-link', a.notes.link)
  root.setProperty('--notes-code', a.notes.code)
  root.setProperty('--notes-quote', a.notes.quote)
  root.setProperty('--notes-quote-wash', withAlpha(a.notes.quote, 0.5))
}
