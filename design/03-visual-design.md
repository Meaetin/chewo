# 03 — Visual Design

Status: DRAFT — awaiting review
Persona: Visual Designer · Inputs: `00-brief.md` (locked + open axes), `01-current-state.md`, `02-art-direction.md` ("Kiln"), `styles.css@3e75a0e`
Job: turn the Kiln art direction into buildable, named tokens and a per-surface spec the Design Systems persona can componentize and the mockup builder can render pixel-for-pixel.

This document **only adds precision**. It invents no new colors — every hue references an AD token by name (`--clay`, `--surface-2`, `--line-1`, …). Where a concrete value was needed that the AD did not give, it is flagged **NEEDS AD TOKEN**.

---

## 0. Token families at a glance

The AD defined the color world (§3 of `02`). This doc adds four missing families the current `:root` (12 tokens) never had: **type, space, radius, elevation**, plus line/border and mono. Full `:root` target:

- Color: `--surface-0…5`, `--line-1/2`, `--text-primary/secondary/tertiary/faint`, `--clay-wash/hi/clay/deep`, `--on-clay`, `--danger/warning/live` (+ washes), badge hues. *(AD §3 — not re-listed here.)*
- Type: `--text-2xs … --text-2xl` + line-height/weight/tracking companions, `--font-ui`, `--font-serif`, `--font-mono`.
- Space: `--space-2 … --space-32`.
- Radius: `--radius-1 … --radius-4`, `--radius-pill`.
- Elevation: `--rim`, `--shadow-popover`, `--shadow-overlay`.

Success criterion #2 (zero orphan hex) is only met when every value below is a token.

---

## 1. Type scale

**Face tokens**

| Token | Stack |
|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif` |
| `--font-serif` | `'Source Serif 4', Georgia, serif` — variant (a) only; §8 |
| `--font-mono` | `'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace` (kills the ~11 string literals + `TerminalPane.tsx:21`) |

**Weights (AD limit — 400/500/600, no 700).** `--weight-regular: 400`, `--weight-medium: 500`, `--weight-semibold: 600`. Every current `font-weight:700` (role labels, tool-call name, badges, scope names) drops to 600.

**The scale.** Whole pixels only — kills `11.5`/`12.5`. UI text deliberately lives in a tight 10–15px band (dense daily-driver chrome); display type steps out to 18/24. The 1px increments in the UI band are intentional and each earns a distinct job.

| Token | px | line-height | weight | letter-spacing | Renders in | Where used |
|---|---|---|---|---|---|---|
| `--text-2xs` | 10 | 14px (1.4) | 600 | +0.02em | UI | Source badges (CC/CX/SH), live counts, `command-chip-symbol`, `copy-modal-has-one` |
| `--text-xs` | 11 | 16px (1.45) | 500 | 0 (caps: **+0.06em**) | UI / mono | Meta + timestamps (`session-item-time`, `note-page-date`, `transcript-meta`), **small-caps section headers** (`project-rail-header`, `capability-group-title`, `notes-pages-title`, `notes-chat-title`, `wt-field-label`), tool-call detail/output (mono), commit sha (mono), find-count |
| `--text-sm` | 12 | 17px (1.45) | 400 (labels 500) | 0 | UI | Tab label, breadcrumb, button text, secondary body, `capability-detail`, banners, `project-row-count`, chevrons |
| `--text-base` | 13 | 20px (1.5) | 400 | 0 | UI | **Default UI body**; sidebar row titles, input text, modal body copy, agent options, notes chat message body |
| `--text-md` | 14 | 22px (1.6) | 400 | 0 | UI | **Transcript message body**, notes markdown preview, recording live transcript, `capability-scope-name` |
| `--text-lg` | 15 | 21px (1.4) | 600 | 0 | UI | Transcript title, modal title (was 14), `wt-empty-title`, markdown `h2` |
| `--text-xl` | 18 | 24px (1.35) | 600 (serif 500) | -0.005em | **serif (a) / UI (b)** | **Notes lesson title** (was 16), small empty-state headline, markdown `h1` |
| `--text-2xl` | 24 | 30px (1.25) | 600 (serif 500) | -0.01em | **serif (a) / UI (b)** | Empty-state headlines, first-run / feature-intro headlines |

**Mono sizes** (own track, not the UI scale): inline code / `wt-input-mono` = 12px; tool-call detail, tool-result output, diffstat, commit sha, hook preview, `wt-field-hint` code = 11px; **terminal xterm = 13px default**, user-zoomable ⌘±/0 (unchanged behavior). CodeMirror editor body = 13px mono.

**Decisions this forced:**
- **Killed 16px entirely.** Notes title rose to 18 (needed anyway for the serif ≥18px rule), markdown `h1` folded to 18, `h2` to 15. One fewer step, cleaner rhythm.
- **Role labels drop 700→600** and shrink tracking to the caps standard +0.06em (AD asked to kill the 700 role labels).
- **`capability-scope-name` moved 14/700 → 14/600 at `--text-md`**; the group titles carry the hierarchy via small-caps, not weight.

---

## 2. Spacing system

**Base unit 4px.** Ramp (AD-proposed): named by pixel value for zero ambiguity.

| Token | px | Primary role |
|---|---|---|
| `--space-2` | 2 | Hairline insets, icon nudge, `-1px`-class merges |
| `--space-4` | 4 | Tightest gap (switcher gap, chevron gap, rec-tabs gap) |
| `--space-6` | 6 | Row inner gap, small vertical padding |
| `--space-8` | 8 | Standard control gap, action-row gap |
| `--space-12` | 12 | Row horizontal padding, card inner, gutter |
| `--space-16` | 16 | Panel padding, section gap, card→card gap |
| `--space-20` | 20 | Modal horizontal padding, editorial gutter |
| `--space-24` | 24 | Generous block spacing (empty states) |
| `--space-32` | 32 | Max rhythm (first-run cards, large empties) |

The ramp omits 10/14/18/28 on purpose. Every ad-hoc value maps up or down to the nearest rung:

| Current (ad hoc) | → Token | Notes |
|---|---|---|
| `6px 12px` (project-row) | `--space-6 --space-12` | Becomes **the** list-row standard |
| `7px 12px` (session-item) | `--space-6 --space-12` | Unify to row standard |
| `7px 14px` (wt-button) | `--space-8 --space-16` | Button standard (below) |
| `8px 10px` (wt-input) | `--space-8 --space-12` | Input standard |
| `7px 10px` (search) | `--space-8 --space-12` | Input standard |
| `5px 8px / 5px 10px / 5px 12px` | `--space-6 --space-8/12` | Small inputs/toggles round 5→6 |
| `8px 14px` (agent option) | `--space-8 --space-16` | |
| `8px 16px` (resume) | `--space-8 --space-16` | |
| `12px 14px` (capability-card) | `--space-12 --space-16` | Card standard |
| `16px 18px` (modal body) | `--space-16 --space-20` | Modal standard |
| `14px 18px` (transcript/caps header) | `--space-16 --space-20` | Header standard |
| `12px 16px` (toast) | `--space-12 --space-16` | Overlay standard |
| section gap `14px` | `--space-16` | |

**Component padding standards** (one value per primitive — kills the 15-variant sprawl):

| Primitive | Padding | Radius |
|---|---|---|
| Button (default) | `8px 16px` (`--space-8 --space-16`) | `--radius-2` |
| Button (compact: mode toggles, chips, nav) | `6px 12px` | `--radius-2` |
| Icon-only button | `0`, fixed `28×28` box (dense sidebar `24×24`) | `--radius-2` |
| Input / textarea / select trigger | `8px 12px` | `--radius-2` |
| List row (sidebar, notes, capability) | `6px 12px` | none (full-bleed) / `--radius-2` for inset rows |
| Card (capability, first-run) | `12px 16px` | `--radius-3` |
| Modal header / body / footer | `16px 20px` (footer `12px 20px`) | — |
| Section gap (between cards/groups) | `--space-16` | — |
| Panel edge padding (headers, rails) | `16px 20px` main / `10px 12px` sidebar | — |

Terminal xterm inner padding stays off-grid by intent (AD §7: 14px option A, 16px option B — charcell-driven, not layout). Flagged, not forced.

---

## 3. Radius & border tokens

**Radius — the AD's four stops, formalized. No value outside this set** (kills 3/4/5/6/7/8/10/12 chaos).

| Token | px | Used by |
|---|---|---|
| `--radius-1` | 5 | Source badges, tool/command chips, inline code, select options, small toggles |
| `--radius-2` | 7 | Buttons, inputs, textareas, select trigger, tabs (top corners), list rows, banners, find-input, level-meter track |
| `--radius-3` | 10 | Cards, panels, modals→no (see 4), terminal card (Option A), tooltip, toast, popover menu, message-user bubble, tool-result output block |
| `--radius-4` | 14 | Modals only (`ModalShell`, unified copy/memory) |
| `--radius-pill` | 999px | Record control only (AD's one sanctioned pill) |

**Line & border tokens**

| Token | Value | Role |
|---|---|---|
| `--line-1` | `#3A322A` (AD Seam) | Default 1px hairlines: panel seams, dividers, row separators, card borders, tab dividers, banner borders |
| `--line-2` | `#4A4036` (AD Grain) | Stronger 1px: input borders, overlay borders, rim-light source |
| `--border-selected` | `2px solid var(--clay)` | The left selection bar on every selected row (§4 selection rule) |
| `--focus-ring` | `0 0 0 3px var(--clay-wash)` + `border-color: var(--clay)` | One focus treatment app-wide |

Composite conveniences: `--border-hair: 1px solid var(--line-1)`; `--border-input: 1px solid var(--line-2)`.

---

## 4. Per-surface visual spec

Cross-cutting rules resolved here, applied everywhere below:

- **One selection treatment.** Every selected row = `--clay-wash` fill + `--border-selected` (2px `--clay` left bar). Kills the blue-vs-orange split (`project-row` was `--accent-codex`; sessions/notes were `--accent-claude`). Hover = `--surface-4` fill, no bar. Focus = `--focus-ring`.
- **One input treatment.** Fill `--surface-1`, `--border-input`, `--radius-2`, `8px 12px`, `--text-base`. Focus = `--focus-ring`. Applies to all 7 current input variants.
- **One overlay treatment.** `--surface-3` fill, 1px `--line-2` border, `--rim`, `--shadow-overlay`/`--shadow-popover` (§6). Merges the two modal systems.
- **Seams over shadows.** In-flow separation = one surface step + 1px `--line-1`. No shadows on rows/cards/tabs, ever.

| Surface | Bg | Spacing | Type | Border / seam | Selected / hover / focus | Kiln rules landing |
|---|---|---|---|---|---|---|
| **Sidebar column** | `--surface-2` (Roast) | header zone 40px drag (§5); rails `10px 12px`; rows `6px 12px` | rows `--text-base`; headers `--text-xs` small-caps +0.06em `--text-tertiary` | right seam 1px `--line-1` vs canvas | — | Grain 2–3% permitted here (variant); calm base |
| **Workflow switcher** | in drag zone; buttons `--surface-5` when active | `6px 12px`, gap `--space-4` | `--text-sm` | active: `--border-hair`; idle: transparent | active = `--surface-5` (Walnut, non-accent neutral) + `--clay` icon; **active label is the one clay text** | Moves into traffic-light row (§5); `-webkit-app-region:no-drag` |
| **Sidebar action row** (+CC/+CX/⎇/⛭) | buttons `--surface-3` | row `--space-8` gap, `10px 12px` | icon 14/1.75; `--text-sm` label | `--border-hair` | hover `--surface-4`; icon `--text-tertiary`→`--text-primary` | Lucide icons (§7); no accent at rest |
| **Session search / notes-add input** | `--surface-1` | `8px 12px`, margin `0 --space-12 --space-12` | `--text-base` | `--border-input` | focus `--focus-ring` | Unified input spec |
| **Project / session / notes / note-page / capability rows** | inherit `--surface-2` | `6px 12px`, gap `--space-6` | title `--text-base`; meta `--text-xs` `--text-tertiary` | — | **selected = `--clay-wash` + 2px `--clay` bar**; hover `--surface-4`; live tint = `--live` wash (§below) | The single selection rule; kills accent split |
| **Live session row** | `--live` wash (`≈#25281E`) tint | — | title tinted toward `--live` | — | live **dot = `--live` (sage)**; `project-row-live` count also `--live` (was orange) | "Live uses one color" fix; no pulse while healthy |
| **Tab bar rail** | Option A `--surface-0` / Option B `--surface-2` | `6px 8px 0`, min-h 38 | tab label `--text-sm` `--text-secondary` | bottom 1px `--line-1`; tab dividers 1px `--line-1` | active tab fill = `--surface-1`, `margin-bottom:-1px` merge, top `--radius-2`, label `--text-primary` | Merged active tab kept (AD blesses it) |
| **Ghost / dormant tab** | transparent | — | label **italic** `--text-tertiary` | — | `play` glyph prefix (14/1.75) + italic — **not opacity alone** (anti-pattern §9) | Replaces `opacity:.5`-only tell |
| **Exited tab** | transparent | — | strikethrough-free, `--text-faint` | — | `x` visible on hover | |
| **Terminal pane — Option A (inset card)** | main panel `--surface-0`; card `--surface-1` | card margin `10px` L/R/B; xterm inner 14px | mono 13 | card 1px `--line-1`, `--radius-3`, **no shadow** | active tab merges into card top edge | "Sheet on the bench"; Kiln ANSI (§ below) |
| **Terminal pane — Option B (full-bleed)** | `--surface-1` edge-to-edge | xterm inner 16px | mono 13 | 1px `--line-1` seam vs sidebar; **12px `--surface-2`→transparent gradient** under tab rail | merged active tab | "Dark room"; warmth from ANSI + tone |
| **Transcript view** | Option A card / Option B `--surface-1` | header `16px 20px`; messages `16px 20px`, gap `--space-12`; **measure max 740px** | body `--text-md` (1.6); title `--text-lg`; role label `--text-xs` small-caps `--text-tertiary`; meta `--text-xs` mono | header 1px `--line-1` | user bubble = `--surface-3`, `--radius-3`; find highlight `--clay-wash`, current `--clay` + `--on-clay` | Widest measure, most air; chrome→hairlines; role labels whisper |
| **Tool-call chip / result** | `--surface-3` | `4px 10px` chip; result `10px 12px` | name `--text-xs` 600 (was blue 700 — now `--text-secondary`); detail/output mono 11 | 1px `--line-1`, `--radius-2` (result `--radius-3`) | hover `--surface-4` | Name loses codex-blue; source hue lives only in badges |
| **Command chip** | `--surface-3` | `3px 10px` | `--text-xs` `--text-tertiary` | 1px **dashed** `--line-1`, `--radius-1` | — | Dashed = "slash command" affordance kept |
| **Capabilities view** | Option A card / `--surface-1`; cards `--surface-3` | header `16px 20px`; scroll `16px 20px`, gap `--space-16`, **max-width 880 → clamp(0, min(880px,100%))**; card `12px 16px` | scope name `--text-md` 600; group title `--text-xs` small-caps; row `--text-base` | card 1px `--line-1`, `--radius-3`; rows borderless | row hover `--surface-4`, `--radius-2`; `copy-to-button` `--surface-3`→`--surface-4` | Renders as the same "sheet" card as transcript (Option A) |
| **Notes sidebar** | `--surface-2` | rows `6px 12px 6px 8px`; add `4px 12px` | topic `--text-base`; header `--text-xs` small-caps | right seam 1px `--line-1` | unified selection (clay-wash + bar) | Warmest-workflow cue is in the editor, not the rail |
| **Notes pages list** | `--surface-2` | header `10px 12px 6px`; row `6px 12px` | title `--text-base`; date `--text-xs` `--text-tertiary` | right seam 1px `--line-1` | unified selection | Width 240 (§5) |
| **Notes editor** | `--surface-1` (warmest content) | header `10px 16px`; CM `12px 16px` | **title `--text-xl` — serif in variant (a)**; body mono 13 (1.6) | header 1px `--line-1` | title input borderless, focus `--focus-ring` on wrapper | The one literary flourish; CM theme reads `--surface-1` |
| **Notes markdown preview** | `--surface-1` | `16px 20px`, measure max 740 | `--text-md` (1.6) | — | — | Same editorial measure as transcript |
| **Notes workspace bar** | `--surface-2` | `8px 16px`, gap `--space-12` | breadcrumb `--text-sm` `--text-tertiary` | bottom 1px `--line-1` | — | ✦ Ask = `sparkles`; ● Record = `mic` (§7) |
| **Recording panel** | `--surface-1` | status row `12px 16px`; transcript `16px 20px`, measure 740 | live transcript `--text-md` (1.7); elapsed `--text-base` tabular 600 | status row 1px `--line-1` | **record dot = `--clay`, 2s breathe** (only sustained loop); level-meter fill `--live` | Notebook, not IDE; structuring status = mono `--text-xs` `--text-tertiary` (machine voice) |
| **Recording controls** | Record = `--radius-pill` outline; Stop = `--danger`-tinted | `6px 14px→8px 16px` | `--text-sm` 600 | 1px | Stop = `--danger` text + wash bg, hover deepen | Record is the one pill; stop uses ember, not clay |
| **Notes chat** | `--surface-2` | header `10px 12px`; messages `12px`, gap `--space-12`; input row `10px 12px` | body `--text-base` (1.55); title `--text-xs` small-caps | left seam 1px `--line-1` | user msg `--surface-3` `--radius-3`; assistant `--surface-1` + `--border-hair`; error uses `--danger` (not clay) | Scope `<select>` → unified `Select` primitive (kills raw native select); width 340 (§5) |
| **Modals (unified)** | `--surface-3` | header/body `16px 20px`, footer `12px 20px` | title `--text-lg` 600; field-label `--text-xs` small-caps; body `--text-base` | 1px `--line-2`, `--radius-4`, `--rim` + `--shadow-overlay` | primary btn = `--clay` + `--on-clay`; danger = `--danger` text | **`copy-modal` + `memory-viewer` migrate onto `ModalShell`** — one system, one backdrop `rgba(0,0,0,0.55)`, one Esc handler |
| **Select popover** | `--surface-3` | menu `4px`; option `7px 8px` `--radius-1` | option `--text-base`; detail `--text-xs` | 1px `--line-2`, `--radius-3`, `--rim` + `--shadow-popover` | active option `--surface-5`; check mark `--clay` (was codex blue) | Overlay recipe; check hue = clay not blue |
| **Toast** | `--surface-3` | `12px 16px`, `--radius-3` | `--text-sm` (1.5) | 1px `--line-2` (was `--clay` border) + `--rim` + `--shadow-popover`; **left 3px `--clay` accent bar** for identity | — | Accent moves from full border to a single bar — calmer |
| **Tooltip (new primitive)** | `--surface-3` | `4px 8px`, `--radius-1` | `--text-xs` `--text-primary` | 1px `--line-2`, `--rim` + `--shadow-popover` | fade ≤120ms | Replaces every native `title=""`; required on icon-only buttons |

**Buttons — one primitive, three intents** (collapses ~15 classes):

| Intent | Rest | Hover | Active |
|---|---|---|---|
| Neutral (default) | `--surface-3` fill, `--border-hair`, `--text-primary` | `--surface-4` | `--surface-5` |
| Primary | `--clay` fill, no border, **`--on-clay` text** (`#241610`, not `#fff`) | `--clay-hi` fill | `--clay-deep` fill |
| Danger | transparent, `--danger` text | `--danger` wash bg | deeper wash |

This kills the three divergent CTAs (`resume-button` white-on-clay, `wt-button-primary` white-on-clay, `copy-modal-apply` no-hover) — all become one Primary with `--on-clay` text and a real hover/active.

---

## 5. Layout & density

- **Sidebar column: keep 300px** (`min-width:300px`). Roomy enough for CC/CX badge + title + time + hover actions without truncation; Arc/Notion sit 260–320. No change.
- **Top-of-sidebar (new, hiddenInset).** `titleBarStyle:'hiddenInset'` → traffic lights float top-left. New layout:
  - A **40px header zone** at the top of `--surface-2`, `-webkit-app-region: drag`.
  - Traffic lights occupy the left ~72px. The **WorkflowSwitcher moves into this zone, right of the lights**: `padding-left: 76px` to clear them, vertically centered, its two buttons `-webkit-app-region: no-drag`.
  - Below the drag zone, sidebar content begins (action row, search, lists) — the old top `10px` switcher padding is removed.
  - Window `backgroundColor` = `--surface-0` so resize flashes stay warm (kills `#16161e`).
- **Main panel:** flexible. Option A adds `10px` L/R card margins (≈22px column cost, accepted). Option B edge-to-edge.
- **Transcript / notes-preview / recording measure: `max-width: 740px`** (AD's editorial measure; current transcript is 780 → tighten). Left-aligned within its column, not centered, so it stays anchored to the reading edge.
- **Notes page list: 240px** (was 230 — round to `8×30` grid; negligible visual change, on-system). **Notes chat: keep 340px.**
- **Min-window behavior.** Personal daily driver on a large display; adaptation is minimal by intent (Martin flag: multi-agent, big screens). Rules: sidebar fixed 300 (never shrinks); main panel `min-width: 480`; **notes chat is the first to collapse** (toggle off) under ~1100px; capabilities/transcript measure already `min(740px,100%)` so they reflow. No responsive breakpoints beyond these — magic caps (880/844/220) become `min(…, 100%)` clamps so nothing overflows a narrow window (rough-edge #10).

---

## 6. Elevation recipe

Dark elevation = **light, not shadow** (AD §5). Exact CSS:

```css
--rim:             inset 0 1px 0 rgba(255, 240, 225, 0.05);
--shadow-popover:  0 8px 24px rgba(0, 0, 0, 0.40);
--shadow-overlay:  0 16px 40px rgba(0, 0, 0, 0.45);
```

Overlay surfaces compose rim + one drop:

```css
/* modals */   box-shadow: var(--rim), var(--shadow-overlay);
/* popovers */ box-shadow: var(--rim), var(--shadow-popover);
```

| Surface | Recipe |
|---|---|
| Modals (unified `ModalShell`) | `--surface-3`, 1px `--line-2`, `--radius-4`, `--rim` + `--shadow-overlay` |
| Select popover menu | `--surface-3`, 1px `--line-2`, `--radius-3`, `--rim` + `--shadow-popover` |
| Toast | `--surface-3`, 1px `--line-2`, `--radius-3`, `--rim` + `--shadow-popover` |
| Tooltip | `--surface-3`, 1px `--line-2`, `--radius-1`, `--rim` + `--shadow-popover` |

**Everything else gets zero box-shadow.** In-flow rows, cards, tabs, terminal card (Option A) separate by surface step + `--line-1` only. (Drops the current `0 16px 48px / 0 12px 40px / 0 12px 32px / 0 6px 24px` four-shadow zoo down to two tokens.)

---

## 7. Iconography application

One library: **`lucide-react`**. Default **16px / stroke 1.75**; dense sidebar rows **14px / 1.75**; empty states + modals **20px / 1.5**. Icons inherit text color: `--text-tertiary` at rest → `--text-primary` on hover → `--clay` only when active/selected. No icon carries its own hue except the live dot (sage) and danger contexts (ember). Every icon-only button gets the tooltip primitive (§4). Emoji banned from chrome.

| Today | Meaning | Lucide name | Size/stroke |
|---|---|---|---|
| ⎇ | Isolated / new worktree | `git-branch` | 14/1.75 (sidebar action) |
| ⛭ | Capabilities manager | `blocks` | 14/1.75 |
| ⚙ | Section settings | `settings` | 14/1.75 (row hover action) |
| ⇤ | Merge worktree | `git-merge` | 14/1.75 (tab) |
| ⎘ | Paste page | `clipboard-paste` | 16/1.75 |
| ✦ | Ask your notes | `sparkles` | 16/1.75 |
| ● | Start recording | `mic` | 16/1.75 (in the pill control) |
| ● | Recording/live indicator | *CSS dot*, not an icon — `--clay` (record) / `--live` (live), 8px | — |
| ▶ | Resume transcript | `play` | 16/1.75 |
| ▶ | Ghost/dormant tab prefix | `play` (outline) + italic label | 14/1.75 |
| ■ | Stop recording | `square` | 16/1.75 |
| ✕ | Close (all surfaces) | `x` | 16/1.75 (20 in modals) |
| 🔑 | API-key / auth capability | `key-round` | 16/1.75 |
| ⚠ | Warning | `triangle-alert` | 16/1.75, color `--warning` |
| ↻ / ⟳ | Refresh (merge review) | `rotate-cw` | 14/1.75 |
| ▸ / ▾ | Expand / collapse | `chevron-right` / `chevron-down` | 14/1.75 |
| + | New (project, shell, page) | `plus` | 16/1.75 (18 for `new-shell`) |
| ↩ | Send (notes chat) | `arrow-up` | 16/1.75 |

Source badges (CC/CX/SH) stay **text chips**, not icons — they carry the only per-source hue in the app (AD §3.5).

---

## 8. The variant axes, rendered

The mockup builder must show **both sides** of each of the four open axes (`00` §"Open decisions", `02` §"Open decisions"). Checklist:

| Axis | Variant (a) — render | Variant (b) — render | Where it's visible in the mockup |
|---|---|---|---|
| **Editorial serif** | `--font-serif` (Source Serif 4) on `--text-xl` **notes lesson title**, `--text-2xl` **empty-state headline**, first-run headline — weight 500, always ≥18px | Same three spots in `--font-ui` SF Pro, weight 600 to hold presence | Notes editor title bar; a code empty state; a notes empty state |
| **Codex blue** | Denim `#8FA9C9` on the **CX badge** + its chip bg `rgba(143,169,201,0.10)` + ANSI blue slot | Vivid `#6ba4f8` in the same spots | CC and CX badges shown side by side on a sidebar row; a terminal line using ANSI blue |
| **Grain texture** | 2–3% tiled 64px monochrome-noise data-URI on `--surface-0` + sidebar `--surface-2` only (never terminal/editor/transcript) | Flat surfaces | Whole-window backdrop + sidebar; toggle behind one `--grain` var |
| **Terminal treatment** | **Option A inset card** (§4): `--surface-1` card on `--surface-0`, `--radius-3`, 1px `--line-1`, 10px margins, merged tab | **Option B full-bleed** (§4): `--surface-1` edge-to-edge, 16px inner, seam + 12px tab-rail gradient | The terminal pane, with tab bar + one active + one ghost tab; both share the Kiln ANSI theme |

**Kiln ANSI-16 (both terminal variants)** — finalized from AD §7.3 anchors; slots that map to app tokens are marked:

| Slot | Hex | = token |
|---|---|---|
| background | `#1B1714` | `--surface-1` |
| foreground | `#EDE6DD` | `--text-primary` |
| cursor | `#D97757` | `--clay` |
| selection | `rgba(217,119,87,0.25)` | clay 25% |
| black / br-black | `#241E19` / `#5C5248` | — |
| red / br-red | `#E2574B` / `#EC6C61` | `--danger` |
| green / br-green | `#8FBC72` / `#A6CE8B` | `--live` |
| yellow / br-yellow | `#DFA94E` / `#E9BC6E` | `--warning` |
| blue / br-blue | `#8FA9C9` / `#A8BED8` | Denim (variant a) / `#6ba4f8` (variant b) |
| magenta / br-magenta | `#C98AA9` / `#D6A2BC` | — |
| cyan / br-cyan | `#83B5A4` / `#9CC7B8` | — |
| white / br-white | `#D8CEC2` / `#F4EDE4` | — |

Bright variants are the base slot lightened ~10% L (my finalization; **NEEDS AD SIGN-OFF** — AD gave base + a couple brights only).

---

## Deviations & flags

1. **NEEDS AD TOKEN — bright ANSI slots** (br-red/green/yellow/blue/magenta/cyan/black): derived by +10% lightness above; AD specified only base + br-black/br-white. Confirm.
2. **Killed 16px type step** (folded to 18/15). If AD wants the notes title at 16, the serif ≥18px rule breaks — I chose the rule.
3. **Notes page list 230→240**, transcript measure 780→740, capabilities cap 880 → `min(880,100%)`: small numeric normalizations onto grid/measure; visually near-identical.
4. **Toast accent** demoted from full `--clay` border to a 3px left bar + neutral overlay chrome — calmer, matches "nothing shouts."
5. **Tool-call name** loses its codex-blue (`--accent-codex` 700) → `--text-secondary` 600. Source hue now lives only in badges per AD §3.5; flagging because it changes a familiar transcript accent.
6. Everything else strictly executes AD tokens; no new hues introduced.
