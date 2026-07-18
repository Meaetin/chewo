# 00 — Brief

## What Chewo is

A macOS Electron app that unifies Claude Code + Codex CLI: a shared sidebar over
both CLIs' session stores, real terminals (node-pty/xterm), session transcripts,
a capabilities manager, opt-in worktree isolation, and a second "Notes" workflow
(OneNote-style subjects → topics → lessons, with dictation and a Q&A chat over
the notes corpus). See `SPEC.md`, `SPEC-CAPABILITIES.md`, `SPEC-NOTES.md`.

The primary user is Martin: a developer running **multiple AI coding agents
concurrently in the same repo**, all day. The app is a daily driver, not a demo.

## Goal of the overhaul

Make the app look nicer and feel better — a real aesthetic point of view plus
systematic polish — **without changing features**. The information architecture
(sidebar → tabs → main pane; Code ⇆ Notes workflows) has proven itself and
stays. This is a re-skin + refinement, not a re-architecture.

## Locked direction decisions (Martin, 2026-07-18)

| Decision | Choice |
|---|---|
| Vibe | **Warm & crafted** — warmer neutrals, generous spacing, personality in the details. A workspace, not an ops console. |
| Theme | **Dark-first, dark-only.** One theme done exceptionally well. No light mode this round. |
| References | **Arc, Notion, Craft** — expressive, personality-driven products with strong spatial ideas (sidebars, tabs, docs). |
| Draft medium | **Self-contained HTML mockups** (fastest to iterate, closest to implementation). Not Figma/Paper this round. |
| Accent strategy | **Terracotta as brand.** Promote warm terracotta (seeded from `#d97757`, may be tuned) to THE app accent: selection, primary actions, focus. Claude/Codex identity shrinks to small source badges only. |
| Terminal treatment | **Open — Art Director proposes both** inset-card and full-bleed treatments; Martin picks from HTML drafts. |
| Ambition | **Personal daily driver.** Polish for daily joy; skip onboarding/marketing surfaces; invest in the screens Martin lives in. |

### Personality hierarchy (locked)

Martin chose all four personality words; they apply **in layers with strict
precedence** — when two conflict, the earlier wins:

1. **Base temperament — calm & cozy.** The default state of every screen. Low
   surface contrast, soft edges, nothing shouts.
2. **Construction — studio / craft.** How things are built: precise, tactile,
   honest details. Visible structure without noise.
3. **Hierarchy engine — editorial.** Typography does the organizing; chrome
   recedes. Type scale and weight carry the information hierarchy.
4. **Seasoning — playful accents.** Rare, earned moments of delight (an empty
   state, a completion animation). Never the default register.

### Design implication to resolve early

The references (Arc/Notion/Craft) are light-first products; our theme is
dark-only. The synthesis target is a **warm dark workspace**: warm charcoal
surfaces (not blue-black), cream/off-white text (not stark white), and warmth
carried through accents and materials. The existing Claude accent `#d97757`
(terracotta) is already on-palette — a candidate seed for the whole scheme.

## Open decisions — resolve from mockups (Martin, 2026-07-18)

Martin chose to see these rendered before committing. Every downstream persona
must treat them as **variant axes**, not settled — spec both sides, and the
mockups must show each variant so Martin can pick from the real thing.

| Axis | Variants to render |
|---|---|
| Editorial serif | (a) Source Serif 4 in notes titles + empty states + first-run headlines; (b) pure SF Pro discipline. |
| Codex blue | (a) tamed "Denim" `#8FA9C9`; (b) vivid `#6ba4f8`. Show in a badge next to the CC badge. |
| Grain texture | (a) 2–3% noise on window + sidebar; (b) flat. |
| Terminal treatment | (a) inset card; (b) full-bleed. Both share the Kiln ANSI theme. |

Everything else in `02-art-direction.md` (the warm-dark ramp, the one-accent
clay rule, sage live, Lucide icons, hiddenInset title bar, warm-ink-on-clay
buttons, rim-light elevation, four radius stops) is **accepted as direction**
unless a later persona makes a specific, argued case against it.

## Constraints

- **Platform:** Electron on macOS. Single `BrowserWindow`. Title-bar treatment
  may change (e.g. `hiddenInset`) — it's chrome, not a feature.
- **Styling stack:** plain hand-written CSS in one global stylesheet
  (`src/renderer/src/styles.css`), React components, no Tailwind/CSS-in-JS.
  The overhaul should upgrade the token system, not force a stack migration.
- **Terminals are the core canvas.** xterm panes must stay legible and fast;
  they stay mounted across navigation so processes survive. Terminal theme
  colors must be coordinated with the app palette (currently hardcoded
  `#16161e` in three places).
- **Vocabulary:** "session" = one item in the tab bar. Code-level names stay:
  tab (UI chip), terminal (`termId` pty), conversation (`sessionId` transcript).
- **Multi-agent reality:** Martin always runs several agents concurrently in
  one repo. Never design flows that assume one agent per repo; isolation is
  opt-in per terminal.
- **Existing semantic colors:** Claude = orange `#d97757`, Codex = blue
  `#6ba4f8`, live = green `#34d399`. Whether these stay identity-level or
  shrink to badge-level is an open Art Director question.

## Success criteria

1. A stranger opening the app says "this feels considered" within 10 seconds.
2. Every visual property (color, spacing, radius, type size, shadow) traces to
   a named token; zero orphan hex values in `styles.css`.
3. One button primitive, one input primitive, one modal system.
4. Motion exists and is felt but never noticed as "animation."
5. No feature regressions; no IA changes.
