# 06 — Chosen Direction (LOCKED)

Status: LOCKED by Martin, 2026-07-18. This file records the concrete selections
made after reviewing the `kiln.html` explorer + `sidebar-top-variants.html`.

**Precedence:** this doc **supersedes the exploratory color values** in `02`/`03`/
`04` (which were seeded from terracotta). The token *architecture* in `04`
(primitive → semantic → component, variant-as-token, `terminalTheme.ts` for JS
surfaces) still stands unchanged — only the concrete hex values below replace the
warm-terracotta ones. Motion (`05`) is unaffected.

Why the change: the warm-charcoal ("Kiln") base read as "mustard brown / ugly"
to Martin, especially under a warm accent. Direction pivoted to a **cool neutral
base + emerald accent**. Warmth is out; clean/modern is in.

---

## Base palette — Graphite (true neutral gray)

Replaces the warm `--c-surface-*` ramp. No color cast.

| Token | Hex | Role |
|---|---|---|
| `--c-surface-0` | `#141414` | window base, behind cards |
| `--c-surface-1` | `#181818` | terminal + editor canvas (JS single source) |
| `--c-surface-2` | `#1E1E1E` | sidebar, panels, tab rail |
| `--c-surface-3` | `#252525` | cards, modals, overlays, raised rows |
| `--c-surface-4` | `#2C2C2C` | hover fills |
| `--c-surface-5` | `#343434` | pressed / neutral-selected |
| `--c-line-1` | `#3A3A3A` | hairlines, dividers |
| `--c-line-2` | `#484848` | input/overlay borders, rim source |
| `--c-text-primary` | `#E9E7E4` | body, titles, terminal fg |
| `--c-text-secondary` | `#ADAAA6` | secondary labels |
| `--c-text-tertiary` | `#807D78` | meta, timestamps, resting icons |
| `--c-text-faint` | `#5A5854` | placeholders, disabled |

## Accent — Emerald

One HSL triplet drives everything (per `04` §1.6). `--accent-h/s/l = 158 / 52% / 48%`
(≈ `#3BBF8B`).

| Token | Derivation | Note |
|---|---|---|
| `--accent` | `hsl(158 52% 48%)` | selection, focus, primary action |
| `--accent-hover` | L +7% | button/row hover |
| `--accent-press` | S +3%, L −9% | pressed |
| `--accent-text` | L +10% | accent as text/icon on dark |
| `--on-accent` | `hsl(158 30% 12%)` dark ink | **dark ink, NOT white** — tests ~7:1 on emerald; white fails. Keeps the signature dark-ink-on-accent button. |
| accent wash | `hsla(158 52% 48% / 0.12)` | selection fill, chip bg, focus glow |
| `--focus-ring` | `0 0 0 3px hsla(158 52% 48% / 0.30)` | one focus treatment |

**Accent rule stands:** emerald = "you are here / do this" — selection, focus,
primary, active. Nothing else is emerald.

**Selection hierarchy (added 2026-07-18, Martin):** the sidebar has two
concurrent "selected" states that must read as *different colours* — the
**focused terminal/session** = emerald (`--bg-accent-selected` + emerald bar),
and the **expanded project/section container** = a distinct **periwinkle**
`--c-project #948ada` (`--bg-alt-selected` tint + periwinkle bar). Periwinkle
chosen to avoid colliding with emerald, cyan-live, Codex blue, or amber-warning.
The `Row` primitive exposes `tone='accent' | 'alt'` for this.

## Status colors (LOCKED — "green = accent only")

Because the accent is green, running/live and recording move OFF green so the
three signals never blur. These are **fixed** colors, decoupled from the accent.

| State | Color | Hex | Note |
|---|---|---|---|
| Running / live | **cool cyan** | `#34C9D6` (+ wash) | replaces the old sage/mint-teal live dot; clearly distinct from emerald accent and from Codex blue. |
| Recording | **red** | `#E2574B` | the universal record convention. Record dot + Stop button share the red context. |
| Danger (destructive) | ember red | `#E2574B` | same red family as record by intent; context (destructive button vs record dot) disambiguates. |
| Warning | honey | `#DFA94E` | unchanged. |

## Source badges (LOCKED — keep brand colors)

The only per-source hue in the app; **decoupled from base + accent**.

| Badge | Text | Chip bg |
|---|---|---|
| `CC` Claude | terracotta `#D97757` | terracotta wash `rgba(217,119,87,0.12)` |
| `CX` Codex | **vivid** `#6BA4F8` | blue wash `rgba(107,164,248,0.12)` |
| `SH` Shell | `--text-tertiary` | `--c-surface-4` |

Note: the CC badge is the one place terracotta survives — accepted as Claude
brand identity, tiny 2-letter chip only.

## Variant axes (LOCKED)

| Axis | Choice | Implication |
|---|---|---|
| Editorial serif | **ON** | Notes lesson titles + empty-state + first-run headlines in Source Serif 4 (≥18px, weight 500). **Bundle the font (~200KB)** — the mockup faked it with Georgia. |
| Codex blue | **Vivid** `#6BA4F8` | on the CX badge + terminal ANSI blue slot. |
| Grain | **ON** | ~2.5% monochrome noise on window + sidebar only, never on canvas/editor/transcript. Subtle on the neutral base. |
| Terminal treatment | **Full-bleed** | edge-to-edge canvas at `--c-surface-1`, 16px inner padding, 1px seam + 12px tab-rail gradient. No card frame. |

## Sidebar top layout (LOCKED)

Structure = variant 5 (switcher-as-own-row) + the unified CTA from variant 2,
styled subtle:

- **Row 0** — hiddenInset drag strip: faux traffic lights only.
- **Row 1** — Code / Notes segmented control, **full width**, on its own row.
- **Row 2** — `+ New session ▾` unified split-button (caret opens Claude / Codex
  / Shell), styled **secondary** (bordered on a neutral surface, **no accent
  fill** — must not pop), with the two icon actions (new isolated worktree =
  `git-branch`, capabilities = `blocks`) inline to its right.
- **Row 3** — full-width search input.
- Below: the session list (Home / Projects / Hidden) as spec'd in `03` §4.

Rationale (Martin): a filled/bright CTA would stand out too much, and doubly so
with the emerald accent — so the create action stays quiet.

## Terminal ANSI-16 — TO FINALIZE

The `03` §8 ANSI table was warmed for the terracotta base. On Graphite full-bleed
it must be re-tuned cool/neutral: background = `--c-surface-1` `#181818`,
foreground = `#E9E7E4`, **cursor = emerald accent**. Ensure ANSI green is kept
distinct from the emerald cursor (shift ANSI green cooler or the cursor is a
block, not the same hue). Red/yellow/blue map to danger/warning/Codex-vivid.
Finalize before implementation.

## Planned feature — Appearance settings page (RECOMMENDED, pending final go)

An in-app **Settings → Appearance** surface to change colors at runtime.
Recommended because the token architecture already supports it and it de-risks
the color choice (tune live instead of committing forever).

Scope (curated, not raw):
- **Base palette** picker — the 5 presets (Graphite default, Slate, Ink, Taupe,
  Warm), as swatches.
- **Accent** picker — curated swatch families + a hue slider that auto-derives
  hover/press/wash/ink; hex readout.
- **Variant toggles** — serif, grain, terminal treatment, Codex badge style.
- Persist to disk (user settings); apply on launch.

Implementation cost to honor: xterm (`ITheme`), CodeMirror theme, and
`BrowserWindow.backgroundColor` read **JS values, not CSS vars** — a live change
must re-push `terminalTheme.ts` values to those surfaces, not just toggle a
class/attribute. This is a new global "Settings" surface (the app currently has
Section Settings + Capabilities, but no app-wide preferences page) — a small IA
addition, spec it as its own screen.

---

## Still open / to decide later

- Exact cyan for "live" (`#34C9D6` proposed) — confirm against the real terminal.
- Final ANSI-16 set for Graphite (above).
- Whether Appearance settings ships in v1 or after the re-skin lands.
- Bright ANSI slots sign-off (carried from `03`/`04`).
