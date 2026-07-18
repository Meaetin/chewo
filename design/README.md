# Chewo Design Overhaul — Working Docs

This directory is the shared canon for the UI/UX overhaul. Every design-related
agent (and human) reads these files **in order** before proposing or changing
anything visual.

## Reading order

| # | File | What it is | Status |
|---|------|-----------|--------|
| 0 | `00-brief.md` | Product context, goals, constraints, locked decisions | ✅ locked |
| 1 | `01-current-state.md` | Audit of the existing UI (screens, flows, styling, rough edges) | ✅ done |
| 2 | `02-art-direction.md` | Aesthetic + emotional tone: mood, palette, type, voice ("Kiln") | ✅ draft |
| 3 | `03-visual-design.md` | Layout, typography scale, spacing, color application per surface | ✅ draft |
| 4 | `04-design-system.md` | Tokens, component primitives, visual rules | ✅ draft |
| 5 | `05-motion.md` | Animation + microinteraction spec | ✅ draft |
| 6 | `06-chosen-direction.md` | **Martin's LOCKED selections** (base, accent, status, badges, variants, sidebar, appearance-settings) | 🔒 locked |

**⚠️ `06-chosen-direction.md` supersedes the concrete color values in 02–04**
(which were terracotta-seeded). The token *architecture* in 04 stands; only the
hex values change to Graphite base + Emerald accent. Read 06 first for "what to
actually build."

The "twice as premium" persona pass was **cut** (2026-07-18): Chewo is a personal
daily driver, not a product to sell, so a premium/marketable push is out of
scope. Its one useful function — a cross-doc coherence + gap check before
building — is folded into mockup prep instead.

## Process

Persona passes run in sequence, each producing/refining its file:

1. **Art Director** — defines the desired aesthetic and emotional tone.
2. **Visual Designer** — refines layouts, typography, spacing, color.
3. **Design Systems Designer** — standardizes components and visual rules.
4. **Motion Designer** — adds subtle animations and microinteractions.

(The "Senior Startup / twice-as-premium" pass was cut — see the table note.)

Drafts are produced as **self-contained HTML mockups** in `design/mockups/`
after direction is locked (decision 2026-07-18).

## Coherence check (2026-07-18, pre-mockup)

The four spec docs were read end-to-end for conflicts and gaps. They cohere;
the only cross-doc reconciliations, resolved here as canon:

1. **Spinner retired.** `04` §2.14 speced a `Spinner`; `05` §5 (later, wins)
   replaces it with static `Skeleton` + a mono `WorkingText` pulse. Component
   library: **drop `Spinner`, add `Skeleton` + `WorkingText`.** Button's
   `loading` state = label→mono status, width held — no rotating ring anywhere.
2. **Working-pulse** is one loop past the AD's literal "nothing loops except
   recording" — opacity-only, one-per-surface, revertible to static text via a
   token. Accepted; Martin may veto at implementation.

Deferred sign-offs (sensible defaults ship unless Martin objects): bright
ANSI-16 slots (VD's +10%-L derivation), grain noise asset (NEEDS ASSET; ships
flat-capable), `--bg-selected` token name reused for the clay-wash role.

## Rules for agents working in this directory

- Earlier files override later ones on conflict; `00-brief.md` overrides all.
- Don't change files marked ✅ locked without explicit sign-off from Martin.
- Proposals must reference the real code (`src/renderer/src/styles.css`,
  component files) — critique reality, not an imagined app.
- No implementation in the app source during the planning phase.
