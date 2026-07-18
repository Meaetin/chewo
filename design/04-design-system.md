# 04 — Design System

Status: DRAFT — awaiting review
Persona: Design Systems Designer · Inputs: `00-brief.md` (locked + axes), `01-current-state.md`, `02-art-direction.md` ("Kiln"), `03-visual-design.md`, `styles.css@3e75a0e`, `ModalShell.tsx`, `Select.tsx`, `NotesChat.tsx`
Job: fuse the AD color world + VD scales into **one named, layered token system**, a **component-primitive library** (contracts, not code), the **standardization laws** that keep it coherent, and a **phased migration path** off today's 11-token, 15-button, 2-modal reality.

This doc invents no colors and no scale values. Every hex traces to an AD token (`02` §3); every px traces to a VD scale rung (`03` §1–3). Where a value was needed that neither gave, it is flagged **NEEDS TOKEN**.

---

## 0. Architecture in one line

**Three layers, one direction of reference:** `primitive` (raw palette + raw scale values, the only place a literal hex/px lives) → `semantic` (role aliases: `--bg-*`, `--text-*`, `--accent`, `--focus-ring`, `--font-*`) → **components consume semantic tokens only**. Variant axes (serif, Codex blue, grain, terminal A/B) are a fourth concern: each is a single semantic token or `[data-*]` attribute that repoints to a primitive, so flipping a variant is a one-line change, never a rewrite. JS surfaces that can't read CSS vars (xterm, CodeMirror, `BrowserWindow`) import from **one generated `terminalTheme.ts`** whose values are the same primitives, by hand-sync contract.

Rule of thumb enforced everywhere: **primitives may reference nothing; semantics reference only primitives; components reference only semantics.** A component that names a `--surface-*` or a raw hex is a lint failure.

---

## 1. The complete token sheet (copy-pasteable)

Drop this block in at `styles.css:7`, replacing the current 11-token `:root` (lines 7–18). Nothing else in the file needs to change on the same commit — the old names are re-aliased at the bottom of the semantic layer (§1.4) so existing rules keep resolving while you migrate. Phase 1 is literally "paste this, delete the 11 old lines, keep the aliases."

### 1.1 Primitive tokens — color

```css
:root {
  /* ---- Warm-dark neutral ramp (AD §3.1) — R > G > B always ---- */
  --c-surface-0: #171310;  /* Kiln floor — window base, behind cards */
  --c-surface-1: #1B1714;  /* Char — terminal + editor canvas (SINGLE SOURCE, see §1.5) */
  --c-surface-2: #211C17;  /* Roast — sidebar, panels, tab rail */
  --c-surface-3: #272119;  /* Umber — cards, modals, overlays, raised rows */
  --c-surface-4: #2E2720;  /* Bark — hover fills */
  --c-surface-5: #362E25;  /* Walnut — pressed / neutral-selected (segmented control) */
  --c-line-1:    #3A322A;  /* Seam — default hairlines, dividers */
  --c-line-2:    #4A4036;  /* Grain — input borders, overlay borders, rim source */

  /* ---- Text ramp (AD §3.2) — cream, never #fff ---- */
  --c-text-primary:   #EDE6DD;  /* Cream — body, titles, terminal fg */
  --c-text-secondary: #B9AE9F;  /* Oat — secondary labels, inactive tab text */
  --c-text-tertiary:  #8A7F70;  /* Ash — meta, timestamps, resting icons (4.5:1 floor) */
  --c-text-faint:     #625A4F;  /* Smoke — placeholders, disabled (never info-bearing) */

  /* ---- Clay — the one brand accent (AD §3.3) ---- */
  --c-clay-wash: rgba(217, 119, 87, 0.10); /* selected fill, chip bg; ≈#33241D flat on Roast */
  --c-clay-hi:   #E08A66;  /* Glow — accent text/icons on dark, hover fill */
  --c-clay:      #D97757;  /* Clay — THE accent (seed kept untuned) */
  --c-clay-deep: #C05F3E;  /* Fired — pressed/active button, high-emphasis border */
  --c-on-clay:   #241610;  /* warm ink ON clay fills — NOT white (AD §3.3, ~5.8:1) */

  /* ---- Semantic status hues, re-warmed (AD §3.4) ---- */
  --c-danger:       #E2574B;  /* Ember — hue ~5°, hotter than clay */
  --c-danger-wash:  rgba(226, 87, 75, 0.11);   /* ≈#31201C flat on Roast */
  --c-warning:      #DFA94E;  /* Honey — warm amber */
  --c-warning-wash: rgba(223, 169, 78, 0.11);  /* ≈#332A1A flat on Roast */
  --c-live:         #8FBC72;  /* Sage — warm moss "running" */
  --c-live-wash:    rgba(143, 188, 114, 0.11); /* ≈#25281E flat on Roast */

  /* ---- Source-badge hues — the ONLY per-source color (AD §3.5) ---- */
  --c-denim:      #8FA9C9;  /* tamed Codex blue (variant a, default) */
  --c-denim-wash: rgba(143, 169, 201, 0.10);
  --c-codex-vivid: #6ba4f8; /* Codex blue variant (b) — see §1.6 */

  /* ---- Rim / drop primitives (AD §5, VD §6) ---- */
  --c-rim: rgba(255, 240, 225, 0.05); /* inset top rim-light on overlays */
```

### 1.2 Primitive tokens — type, space, radius, elevation (VD §1–3, §6)

```css
  /* ---- Font stacks (VD §1) ---- */
  --font-ui-stack:    -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
  --font-serif-stack: 'Source Serif 4', Georgia, serif;
  --font-mono-stack:  'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace;

  /* ---- Type scale (VD §1) — whole px only, no 11.5/12.5 ---- */
  --fs-2xs: 10px;  --lh-2xs: 14px;
  --fs-xs:  11px;  --lh-xs:  16px;
  --fs-sm:  12px;  --lh-sm:  17px;
  --fs-base:13px;  --lh-base:20px;   /* default UI body */
  --fs-md:  14px;  --lh-md:  22px;   /* transcript/notes reading body */
  --fs-lg:  15px;  --lh-lg:  21px;
  --fs-xl:  18px;  --lh-xl:  24px;   /* notes title, small display */
  --fs-2xl: 24px;  --lh-2xl: 30px;   /* empty-state / first-run headline */
  /* mono track (VD §1, own sizes): inline/code 12, detail/sha/hint 11, terminal+CM 13 */
  --fs-mono-sm: 11px;  --fs-mono: 12px;  --fs-mono-lg: 13px;

  /* ---- Weights (AD §4 — 400/500/600, no 700) ---- */
  --weight-regular: 400;
  --weight-medium:  500;
  --weight-semibold:600;

  /* ---- Tracking ---- */
  --tracking-caps: 0.06em;   /* small-caps section headers */
  --tracking-badge:0.02em;   /* 2xs badges/counts */
  --tracking-tight:-0.01em;  /* 2xl display */

  /* ---- Space scale (VD §2) — base 4, omits 10/14/18/28 ---- */
  --space-2: 2px;  --space-4: 4px;  --space-6: 6px;  --space-8: 8px;
  --space-12:12px; --space-16:16px; --space-20:20px; --space-24:24px; --space-32:32px;

  /* ---- Radius (AD §5 / VD §3) — four stops + one pill, no other value ---- */
  --radius-1: 5px;   /* chips, badges, inline code, select options */
  --radius-2: 7px;   /* buttons, inputs, tabs, rows, banners */
  --radius-3: 10px;  /* cards, panels, overlays, terminal card (Option A) */
  --radius-4: 14px;  /* modals only */
  --radius-pill: 999px; /* record control only */

  /* ---- Elevation (VD §6) — light not shadow ---- */
  --rim:            inset 0 1px 0 var(--c-rim);
  --shadow-popover: 0 8px 24px rgba(0, 0, 0, 0.40);
  --shadow-overlay: 0 16px 40px rgba(0, 0, 0, 0.45);
```

### 1.3 Semantic tokens — role aliases (components consume ONLY these)

```css
  /* ---- Backgrounds ---- */
  --bg-window:   var(--c-surface-0); /* app base, behind cards; = BrowserWindow bg */
  --bg-canvas:   var(--c-surface-1); /* terminal/editor content surface */
  --bg-sidebar:  var(--c-surface-2); /* sidebar, panels, tab rail */
  --bg-card:     var(--c-surface-3); /* cards, modals, overlays, raised rows */
  --bg-hover:    var(--c-surface-4); /* hover fill on rows/buttons */
  --bg-selected: var(--c-clay-wash); /* clay-wash selection fill (rows/tabs) */
  --bg-neutral-selected: var(--c-surface-5); /* non-accent selected (segmented ctrl) */

  /* ---- Text ---- */
  --text-primary:   var(--c-text-primary);
  --text-secondary: var(--c-text-secondary);
  --text-tertiary:  var(--c-text-tertiary);
  --text-faint:     var(--c-text-faint);

  /* ---- Borders & focus ---- */
  --border-hairline: var(--c-line-1); /* 1px seams, dividers, card borders */
  --border-strong:   var(--c-line-2); /* input borders, overlay borders */
  --border-selected: var(--c-clay);   /* 2px left selection bar */
  --focus-ring:      0 0 0 3px var(--c-clay-wash); /* + border-color:var(--accent) */

  /* ---- Accent (clay) ---- */
  --accent:       var(--c-clay);
  --accent-hover: var(--c-clay-hi);
  --accent-press: var(--c-clay-deep);
  --accent-text:  var(--c-clay-hi);   /* accent as text/icon on dark */
  --on-accent:    var(--c-on-clay);   /* ink on accent fills */

  /* ---- Status ---- */
  --danger:  var(--c-danger);   --danger-bg:  var(--c-danger-wash);
  --warning: var(--c-warning);  --warning-bg: var(--c-warning-wash);
  --live:    var(--c-live);     --live-bg:    var(--c-live-wash);

  /* ---- Fonts (the tokens every rule uses; kills the 11 mono literals) ---- */
  --font-ui:    var(--font-ui-stack);
  --font-mono:  var(--font-mono-stack);
  --font-serif: var(--font-serif-stack);
  /* display face is a VARIANT switch — see §1.6 */

  /* ---- Composite conveniences ---- */
  --border-hair:  1px solid var(--border-hairline);
  --border-input: 1px solid var(--border-strong);
  --shadow-modal: var(--rim), var(--shadow-overlay);
  --shadow-float: var(--rim), var(--shadow-popover);
}
```

### 1.4 The old 11-token `:root` → new mapping (Phase-1 bridge)

Keep these aliases at the end of `:root` on the migration commit so untouched rules resolve; delete each as its consumers move to semantic names. **Every old value is replaced, not just renamed** — the blue-violet ramp is gone.

| Old token | Old value | Re-alias to | New effective value | Note |
|---|---|---|---|---|
| `--bg` | `#16161e` | `var(--bg-canvas)` | `#1B1714` | Was blue-violet; now warm Char. Also the xterm/CM/window source (§1.5). |
| `--bg-panel` | `#1c1c26` | `var(--bg-sidebar)` | `#211C17` | |
| `--bg-hover` | `#24242f` | `var(--bg-hover)` | `#2E2720` | Same name survives, new value. |
| `--bg-selected` | `#2b2b3a` | `var(--bg-neutral-selected)` | `#362E25` | Old neutral selection → Walnut; **accent selection now uses `--bg-selected` (clay-wash)**, a semantics change — audit each consumer (§4 selection rule). |
| `--border` | `#2e2e3a` | `var(--border-hairline)` | `#3A322A` | |
| `--text` | `#d8d8e0` | `var(--text-primary)` | `#EDE6DD` | |
| `--text-dim` | `#8888a0` | `var(--text-tertiary)` | `#8A7F70` | Cool violet-gray → warm Ash. |
| `--accent-claude` | `#d97757` | `var(--accent)` | `#D97757` | Promoted to THE accent. Was also selection on session/notes rows — now generic accent. |
| `--accent-codex` | `#6ba4f8` | *(retire)* → `var(--c-denim)` for badge only | `#8FA9C9` | **No longer a UI color.** Project-row selection + input focus + select-check + tool-call name that used this all move to clay/neutral (§4 migration). Survives only inside the CX badge. |
| `--accent-live` | `#34d399` | `var(--live)` | `#8FBC72` | Mint → sage. |
| *(none)* | — | `--danger` `--warning` | `#E2574B` `#DFA94E` | Net-new: tokenizes the 6× `#e06c75`, 3× `#e5c07b`, one-off `#ef7f88`/`#e88b92`. |

`--bg-selected` is the one alias that changes **meaning** (neutral → accent). Do not blind-swap it; the Phase-1 checklist (§4) lists each of the ~5 consumers.

### 1.5 Single source of truth for JS surfaces — `terminalTheme.ts`

CSS vars don't reach xterm's `ITheme`, CodeMirror's theme, or `BrowserWindow.backgroundColor`. Today `#16161e` is hardcoded in three places (`TerminalPane.tsx:23`, `NotesWorkspace` CM `theme="dark"`, `main/index.ts:52`). Replace with **one exported module** — values are the primitives above, kept in sync by convention (a comment header naming the CSS tokens each field mirrors). Spec only; do not implement here:

```ts
// src/renderer/src/theme/terminalTheme.ts
// SINGLE SOURCE for JS surfaces. Values MUST mirror styles.css primitives (§1.1).
// If a primitive changes, change it here in the same commit.
export const KILN_ANSI = {
  background: '#1B1714',           // --c-surface-1  (also main-process window bg)
  foreground: '#EDE6DD',           // --c-text-primary
  cursor: '#D97757',               // --c-clay
  cursorAccent: '#1B1714',
  selectionBackground: 'rgba(217,119,87,0.25)', // clay 25%
  black: '#241E19',  brightBlack: '#5C5248',
  red: '#E2574B',    brightRed: '#EC6C61',       // --c-danger
  green: '#8FBC72',  brightGreen: '#A6CE8B',     // --c-live
  yellow: '#DFA94E', brightYellow: '#E9BC6E',    // --c-warning
  blue: BADGE_CODEX_BLUE, brightBlue: '#A8BED8', // Denim (a) / #6ba4f8 (b) — §1.6
  magenta: '#C98AA9', brightMagenta: '#D6A2BC',
  cyan: '#83B5A4',   brightCyan: '#9CC7B8',
  white: '#D8CEC2',  brightWhite: '#F4EDE4'
} as const

// Main process imports only these two (share via a tiny constants file so
// main/index.ts has no renderer dependency):
export const WINDOW_BG = '#171310'    // --c-surface-0 (resize flashes stay warm)
export const CANVAS_BG = '#1B1714'    // --c-surface-1 (xterm + CodeMirror)
```

Bright ANSI slots (br-red…br-cyan) are VD's +10%-L finalization and remain **NEEDS AD SIGN-OFF** (VD flag #1 / §5).

### 1.6 Variant axes as tokens (flip = one line)

Each of the four open axes (`00`/`02` "Open decisions") is a single switch. Put the defaults in `:root`; the alternate is a one-token or one-attribute change so the mockups can toggle live.

```css
:root {
  /* (A) Editorial serif — VD §1/§8. Display face + its weight are the switch. */
  --font-display: var(--font-serif);   /* variant (a): Source Serif 4 */
  --weight-display: var(--weight-medium);       /* serif reads at 500 */
  /* variant (b): set --font-display: var(--font-ui); --weight-display: 600; */

  /* (B) Codex blue — AD §3.5. Badge + ANSI blue read this. */
  --badge-codex:     var(--c-denim);        /* (a) tamed denim (default) */
  --badge-codex-bg:  var(--c-denim-wash);
  /* variant (b): --badge-codex: var(--c-codex-vivid); --badge-codex-bg: rgba(107,164,248,0.10); */

  /* (C) Grain — AD §5. One image + one opacity; veto = set opacity 0. */
  --grain-image: url("data:image/png;base64,<64px-noise-tile>"); /* NEEDS ASSET */
  --grain-opacity: 0.025;   /* 2.5%; variant (b) flat: 0 */

  /* (D) Terminal treatment — AD §7. Structural, driven by a body attribute
     (data-terminal="inset" | "bleed"), not a color token. Both share KILN_ANSI. */
}
```

`--font-display` is consumed **only** by the three sanctioned display spots (notes lesson title `--fs-xl`, empty-state + first-run headlines `--fs-2xl`). Everything else names `--font-ui`. Grain applies via a `::before` overlay on `--bg-window` and the sidebar only — never on canvas/editor/transcript (AD §5). Terminal A/B is a layout fork, so it rides a `[data-terminal]` attribute rather than a color token; the mockup builder flips the attribute.

---

## 2. Component primitives (contracts, not code)

Every primitive below consumes **semantic tokens only**. "Replaces" lists the current classes/components it collapses. States are the full set each must implement.

### 2.1 `Button`
- **Consumes:** `--bg-card`, `--bg-hover`, `--bg-neutral-selected`, `--border-hairline`, `--text-primary`, `--accent`, `--accent-hover`, `--accent-press`, `--on-accent`, `--danger`, `--danger-bg`, `--focus-ring`, `--radius-2`, `--fs-sm`/`--fs-base`, `--space-8`/`--space-16` (default), `--space-6`/`--space-12` (compact).
- **Props:** `intent: primary | secondary | ghost | danger`; `size: default | compact | icon`; `iconOnly?: boolean`; `loading?`, `disabled?`.
- **Intents (VD §4 button table):**
  - `primary` — `--accent` fill, no border, **`--on-accent` ink (not white)**. Hover `--accent-hover`, active `--accent-press`. This is the one CTA look.
  - `secondary` (default neutral) — `--bg-card` fill, `--border-hair`, `--text-primary`. Hover `--bg-hover`, active `--bg-neutral-selected`.
  - `ghost` — transparent, `--text-secondary`, no border. Hover `--bg-hover` + `--text-primary`. (Sidebar action buttons, row-hover actions.)
  - `danger` — transparent, `--danger` text. Hover `--danger-bg`, active deeper wash. **Clay never appears on a destructive control** (AD §3.4).
- **States:** rest / hover / active / focus (`--focus-ring`) / disabled (`--text-faint`, no hover, `cursor:default`) / loading (Spinner replaces label/icon, width held, `aria-busy`, non-interactive).
- **The `--on-accent` ink rule:** any element with an `--accent` fill sets text/icon to `--on-accent`. Enforced, not optional — it is the signature detail.
- **Replaces (~15 classes):** `.resume-button`, `.wt-button-primary`, `.copy-modal-apply` → `primary`. `.new-terminal-button`, `.worktree-new-button`, `.capabilities-button`, `.project-add-button`, `.new-shell-button`, `.notes-mode-button`, `.notes-record-lesson-button` → `secondary`/`ghost`. `.show-more-button` → `ghost compact`. `.wt-button` (neutral) → `secondary`. `.recording-stop-button` → `danger`. (Kills the three divergent CTAs — white-on-clay ×2 and the no-hover apply button.)

### 2.2 `Input`
- **Consumes:** `--bg-canvas`, `--border-input`, `--text-primary`, `--text-faint` (placeholder), `--focus-ring`, `--accent` (focus border), `--radius-2`, `--fs-base`, `--space-8`/`--space-12`.
- **Props:** `variant: text | search | textarea`; `leadingIcon?` (search → Lucide `search` 16/1.75, `--text-tertiary`).
- **Focus (one treatment, AD/VD):** `border-color: var(--accent)` + `box-shadow: var(--focus-ring)` (clay border + soft clay-wash glow). Kills the inconsistent "`--accent-codex` border on some, `outline:none` on most."
- **States:** rest / focus / disabled (`--text-faint`, `--bg-sidebar`) / invalid (`--danger` border, only when paired with a message).
- **Replaces (~7 inputs):** `.session-search-input`, `.wt-input`, `.notes-add-input`, `.notes-chat-input`, `.notes-title-input` (borderless title variant — focus ring on wrapper), `.find-input`, `.wt-input-mono` (add `mono` flag → `--font-mono`).

### 2.3 `Select` (extend existing)
- **Keep** `Select.tsx`'s portal + keyboard nav (it exists to fix native-macOS menu behavior). Restyle only.
- **Consumes:** trigger = `Input` recipe (`--bg-canvas`, `--border-input`, `--radius-2`); menu = **overlay recipe** (`--bg-card`, `--border-strong`, `--radius-3`, `--shadow-float`); active option `--bg-neutral-selected`; **check mark `--accent` (was codex blue)** (`Select.tsx:155`); option `--radius-1`, `7px 8px`.
- **Action:** replace the raw native `<select>` in `NotesChat.tsx:144–153` (scope all/subject/topic) with this `Select` — the exact problem it was built to solve. Kill `.notes-chat-scope`.

### 2.4 `Modal` (one system)
- **Keep** `ModalShell.tsx` (Esc + backdrop already correct). It becomes the *only* modal.
- **Consumes:** `--bg-card`, `--border-strong`, `--radius-4`, `--shadow-modal`, header/body `16px 20px`, footer `12px 20px`, title `--fs-lg`/600, backdrop `rgba(0,0,0,0.55)`. Close button → `IconButton` (Lucide `x`, 20/1.75).
- **Props:** `title`, `subtitle?`, `busy?`, `onClose`, `footer`, `size?: default | wide`.
- **Migrate onto it:** `CapabilitiesView.tsx:394–526` copy-modal (`.copy-modal-*`) and `:378–392` memory-viewer (`.memory-viewer`, currently borrows `.terminal-tab-close`). Both delete their bespoke chrome, backdrop (`0.5`/`0.55`), and re-implemented Esc. One backdrop, one Esc, one recipe (AD §5).
- **States:** open (focus-trapped) / busy (backdrop + Esc disabled, per existing `busy`) / closing.

### 2.5 `IconButton` + `Tooltip`
- **`IconButton`:** square hit-box `28×28` (dense sidebar `24×24`), `--radius-2`, transparent fill; Lucide icon 16/1.75 (14 in sidebar), `--text-tertiary` rest → `--text-primary` hover → `--accent` when active/selected. Hover fill `--bg-hover`. **Requires** a `label` prop that feeds a `Tooltip` (no bare icons).
- **`Tooltip`:** overlay recipe small — `--bg-card`, `--border-strong`, `--radius-1`, `4px 8px`, `--fs-xs` `--text-primary`, `--shadow-float`, fade ≤120ms. Replaces **every** native `title=""` (Sidebar actions, tab close/merge, ModalShell close, capabilities actions). Delete `title=` attributes as each icon button migrates.
- **Replaces:** all close buttons (`.capabilities-close-button`, `.wt-modal-close`, `.terminal-tab-close` reuse), all glyph action buttons.

### 2.6 `Badge` (source chips)
- **Consumes:** `--radius-1`, `--fs-2xs`/600/`--tracking-badge`, small-caps. Three fixed variants — **the only per-source color in the app** (AD §3.5):
  - `CC` (Claude): text `--accent-text` (`--c-clay-hi`), bg `--c-clay-wash`.
  - `CX` (Codex): text `--badge-codex`, bg `--badge-codex-bg` (variant-driven, §1.6).
  - `SH` (Shell): text `--text-tertiary`, bg `--c-surface-4`.
- **Replaces:** `.source-badge-{claude,codex,shell}` (already the one consistent primitive — formalize it, repoint hexes to tokens).

### 2.7 `Row` / `ListItem`
- **Consumes:** `--space-6`/`--space-12`, `--fs-base` (title) + `--fs-xs` `--text-tertiary` (meta), hover `--bg-hover`, **selected `--bg-selected` (clay-wash) + 2px `--border-selected` left bar**, `--radius-2` (inset variant).
- **Props:** `selected?`, `live?` (adds `--live-bg` tint + sage dot), `leading?` (badge/icon), `trailing?` (hover-revealed IconButtons), `density: default | compact`.
- **One selection rule (kills the blue-vs-orange split):** every selected row looks identical regardless of surface. `.project-row` (was `--accent-codex`), `.session-item`/notes rows (were `--accent-claude`) all converge.
- **Replaces:** `.project-row`, `.session-item`, `.notes-topic-row`, `.note-page-row`, `.capability-row`, plus `SessionRow`/`SessionGroup` styling in `Sidebar.tsx`.

### 2.8 `Card`
- **Consumes:** `--bg-card`, `--border-hair`, `--radius-3`, `12px 16px`, **no shadow** (in-flow, AD §5). Section gap `--space-16`.
- **Replaces:** capability cards, first-run cards. In Terminal Option A, transcript/capabilities/terminal all render as this "sheet on the bench."

### 2.9 `Toast`
- **Consumes:** overlay recipe (`--bg-card`, `--border-strong`, `--radius-3`, `--shadow-float`) + **3px `--accent` left bar** for identity (VD §4: accent moved from full border to a bar — calmer). `12px 16px`, `--fs-sm`. `z-index: --z-toast`.
- **Replaces:** current `.toast` (whose border was full `--clay`).

### 2.10 `SegmentedControl` (WorkflowSwitcher)
- **Consumes:** container transparent; option idle transparent `--text-secondary`; **active = `--bg-neutral-selected` (Walnut, non-accent) + `--border-hair` + `--accent` icon** — the active label is the one place clay text appears in the switcher. `--space-6`/`--space-12`, gap `--space-4`, `--fs-sm`.
- **Replaces:** `.workflow-switcher-*`. Moves into the hiddenInset drag zone (§3 / AD §5).

### 2.11 `EmptyState`
- **Consumes:** `--font-display` headline `--fs-2xl` (serif variant a), one line `--text-secondary`, one 20/1.5 Lucide glyph `--text-tertiary`, `--space-24`/`--space-32`. Human microcopy permitted here only (AD §8: "Nothing running. The studio is quiet.").
- **Replaces:** `App.tsx` code + notes empty states (currently plain centered text).

### 2.12 `Dot` / status indicator
- **Consumes:** 8px CSS dot. `--live` (running) / `--accent` (recording, 2s breathe — the one sustained loop) / `--text-tertiary` (idle). **Not** an icon (VD §7).
- **Replaces:** `.session-live-dot` (green, keep) **and** `.project-row-live` count (was orange → `--live`) — "live uses one color" fix. Agent-completion soft sage bloom lives here (AD §8.3).

### 2.13 `Tabs` (terminal tab bar)
- **Consumes:** rail `--bg-window` (Option A) / `--bg-sidebar` (Option B), bottom `--border-hair`; tab label `--fs-sm` `--text-secondary`; **active tab = `--bg-canvas` fill, `margin-bottom:-1px` merge, top `--radius-2`, `--text-primary`** (keep the merge trick — AD blesses it).
- **States (no color-only distinction — AD §9):**
  - live: solid.
  - **ghost/dormant:** Lucide `play` (outline, 14/1.75) prefix **+ italic `--text-tertiary` label** — not `opacity:.5` alone (fixes rough-edge #14).
  - exited: `--text-faint`, `x` on hover.
- **Replaces:** one-off tab markup `App.tsx:744–822`, `.terminal-tab*`.

### 2.14 `Spinner` / `Skeleton`
- **NEEDS TOKEN acknowledged as design gap** (rough-edge #8: no loading states exist). `Spinner`: 14px, 1.5 stroke ring, `--text-tertiary`, `--accent` on primary buttons' loading state; ≤1 rotation/s, the one permitted non-record loop **only while actually loading**. `Skeleton`: `--bg-hover` block, `--radius-2`, no shimmer (shimmer = animation without state change, AD §9). Use for "Loading…/Scanning…/Structuring…" text states — but **structuring status stays mono `--text-xs` `--text-tertiary`** (AD's "machine speaking" register), so it gets a Spinner beside the text, not a skeleton.

---

## 3. Standardization rules (the laws)

1. **One-accent rule (enforceable).** Clay = "you are here / do this": selection, focus, primary action, active/recording. Nothing else is clay. Source hues live **only** in `Badge`. Green lives **only** on `Dot`/live tint. *Lint:* grep components for `--c-denim`, `--c-codex-vivid`, `--c-clay*` outside `Badge`/selection/`Button.primary` = review. A highlight that isn't clay (badges/live exempt) is a bug (AD §9).
2. **Focus standard.** Exactly one: `box-shadow: var(--focus-ring)` + `border-color: var(--accent)`. Never `outline: none` without a replacement. Every interactive primitive implements it.
3. **Disabled standard.** `--text-faint` text/icon, no hover, `cursor: default`, no focus ring. `--text-faint` is decorative-only — never encode information in it (AD §3.2).
4. **No orphan hex / no raw px (success criterion #2).** Outside `:root`, zero hex literals and zero raw px for color/space/radius/type. `#fff` (×5) and `#000` are banned outright (AD §9). Terminal xterm inner padding (14/16px) is the single sanctioned off-grid value (charcell-driven, AD §7) — annotate it. *Lint:* `grep -nE '#[0-9a-fA-F]{3,8}' styles.css` must return only `:root`.
5. **Icons.** Lucide only, 16/1.75 default (14 dense, 20 empty/modal), inherit text color, hue only for live (sage) / danger (ember). Icon-only ⇒ `Tooltip`. No emoji/glyphs in chrome (AD §6/§9).
6. **Elevation.** In-flow (rows/cards/tabs/terminal card) = surface step + `--border-hair`, **zero box-shadow**. Overlays = `--shadow-modal` (modals) / `--shadow-float` (popover/toast/tooltip). No other shadow (collapses today's 5-shadow zoo).
7. **Z-index scale (currently ad hoc — 10/20/30 mixed).** Tokenize the stacking order:
   ```css
   --z-base: 0; --z-sticky: 10;      /* find bar, sticky headers (was 10/20) */
   --z-tabbar: 20;                    /* tab rail */
   --z-popover: 800;                  /* Select menu, tooltip (was 30) */
   --z-modal: 900;                    /* ModalShell backdrop+dialog (was 20!) */
   --z-toast: 1000;                   /* above modals */
   ```
   Fixes the real bug that modal backdrop (`styles.css:518` z-20) and tab bar share a plane. Order: base < sticky < tabbar < popover < modal < toast.
8. **Class naming convention.** BEM-lite, component-first: `.btn`, `.btn--primary`, `.btn--compact`, `.btn__icon`; `.row`, `.row--selected`, `.row__meta`. New primitives use this; legacy `.wt-*`/`.notes-*`/`.copy-modal-*` names retire as they migrate. One primitive = one class root (no per-surface `.notes-chat-send` vs `.wt-button-primary` divergence).

---

## 4. Migration map

Ranked into three phases by leverage/risk. Phase 1 is ~80% of the visual win for ~5% of the risk (pure token repoint, no markup change).

### Phase 1 — Tokens only *(highest leverage, lowest risk; ~half a day)*
Drop in §1 sheet; delete old 11 lines; keep §1.4 aliases. Then:

| Do | Where | Effect |
|---|---|---|
| Repoint 11 old tokens via aliases | `styles.css:7–18` | Whole app goes warm-dark in one commit; blue-violet ramp gone. |
| Tokenize danger | `#e06c75` ×6 (incl. `:1340`) + `#ef7f88`/`#e88b92` → `--danger` | Kills 8 orphan reds. |
| Tokenize warning | `#e5c07b` ×3 → `--warning` | |
| Kill `#fff` ×5 | `:737,742,1050,1304,1601` → `--on-accent` (on clay) / `--text-primary` | Removes banned white incl. the `color-mix(... #fff)` hover. |
| Tokenize mono | 11 `'SF Mono'` literals + `TerminalPane.tsx:21` → `--font-mono` | Ends guaranteed drift. |
| Fix triple-hardcoded bg | `TerminalPane.tsx:23`, CM theme, `main/index.ts:52` → `terminalTheme.ts` (`CANVAS_BG`/`WINDOW_BG`) + Kiln ANSI | One source of truth; terminal enters the palette. |
| Audit `--bg-selected` meaning flip | its ~5 consumers (`:270,1715,1816` sessions/notes; `:159` project-row was `--accent-codex`) | Converge to clay-wash + 2px bar (§4 selection rule). **The one Phase-1 item needing per-consumer eyes.** |
| Add z-index tokens | `:518,852,1532,1682` | Fix modal-under-tabbar stacking. |

**Risk:** low. Only the selection-meaning flip and the modal z-index are behavioral; everything else is cosmetic repoint. Success criterion #2 (zero orphan hex) is *met at the end of Phase 1*.

### Phase 2 — Primitives *(medium risk; ~2–3 days)*

| Current | → New primitive | Notes |
|---|---|---|
| ~15 button classes (§2.1 list) | `Button` (primary/secondary/ghost/danger) | Collapse to 4 intents; enforce `--on-accent` ink; give `copy-modal-apply` a real hover. |
| ~7 input classes (§2.2 list) | `Input` (text/search/textarea/mono) | One focus = clay border + wash glow. |
| Native `<select>` | `Select` | `NotesChat.tsx:144` → existing `Select`; check mark clay. |
| `copy-modal-*` + `memory-viewer` | `ModalShell` | Delete two bespoke modal systems; one backdrop/Esc (rough-edge #1). |
| all `title=""` | `Tooltip` + `IconButton` | Every icon button gets a real tooltip. |
| `.source-badge-*` | `Badge` | Repoint to badge tokens; wire CX variant. |
| row classes (§2.7 list) | `Row`/`ListItem` | One hover+selected treatment. |
| tab markup `App.tsx:744–822` | `Tabs` | Ghost tabs get glyph+italic (rough-edge #14). |

**Risk:** medium — real markup changes across Sidebar, App tab bar, CapabilitiesView, NotesChat. Behavior-preserving but touch-heavy. Do `ModalShell` migration first (self-contained), then `Button`/`Input` (broad but mechanical), then `Row`/`Tabs`.

### Phase 3 — Polish + variant wiring *(low risk, high craft; ~2 days)*

| Do | Notes |
|---|---|
| `titleBarStyle:'hiddenInset'` + drag zone | `main/index.ts`; SegmentedControl moves right of traffic lights (AD §5). |
| Lucide icons (`lucide-react`) | Replace glyph soup per VD §7 map; `blocks`/`git-branch`/`sparkles`/`mic`/… |
| `EmptyState`/`Spinner`/`Skeleton` | Fill the missing loading/empty states (rough-edge #8). |
| Wire the 4 variant axes | serif `--font-display`, Codex `--badge-codex`, grain `--grain-*`, terminal `[data-terminal]` (§1.6) — mockup builder toggles these. |
| Terminal A/B, editorial measure 740, clamp magic caps | Per-surface polish (VD §4/§5). |
| Recording breathe, agent-completion bloom, toast bar | The sanctioned motion (AD §8). |
| Delete dead `.notes-record-button` | rough-edge #7. |

**Risk:** low; mostly additive. hiddenInset is the one item with a main-process + layout dependency — test traffic-light overlap.

---

## 5. Open questions / conflicts

1. **AD vs VD — bright ANSI slots.** VD finalized br-red…br-cyan at +10% L; AD gave only base + br-black/br-white. **Carried as NEEDS AD SIGN-OFF** in `terminalTheme.ts`. Escalate to Martin only if he cares about exact bright hues; otherwise VD's derivation ships.
2. **Wash tokens: rgba vs flat.** AD gives clay/danger/warning/live washes as `rgba(...)` *and* a flattened "≈#hex on Roast." **Resolved:** keep the `rgba()` primitive (composites correctly on any surface, incl. hover states); the flat approximations are documentation only, never tokens. If a wash must sit on a non-Roast surface (e.g. selection on a card), rgba is the safe choice — flat would be wrong.
3. **`--bg-selected` semantic reuse.** I reused the *old token name* for the *new clay-wash* role because it reads correctly (`--bg-selected` = the selected fill) and eases the alias bridge — but old `--bg-selected` was a neutral (`#2b2b3a`) used by the segmented control, which now wants `--bg-neutral-selected`. **Flagging:** the one alias whose meaning changed; §4 lists the audit. If Martin prefers zero name-reuse, rename to `--bg-accent-selected` — costs nothing but a find/replace.
4. **Grain asset.** AD wants a 64px monochrome-noise data-URI; none exists yet (**NEEDS ASSET**). Blocks only variant (C-a); default ships flat-capable (`--grain-opacity: 0` = veto).
5. **Serif weight vs UI weight coupling.** Variant (a) serif renders at 500, variant (b) UI at 600 — so flipping `--font-display` must also flip `--weight-display` (§1.6). Two tokens, not one. Called out so the toggle isn't half-applied (serif at 600 looks heavy; SF at 500 looks weak).
6. **Spinner = a new sustained loop.** AD §8 lists exactly five motion allowances and the record breath as "the only sustained animation." A loading Spinner technically violates that. **Resolved:** a Spinner is bounded by a state (loading), not sustained-at-rest, so it fits "no animation without a state change" (AD §9) — but it must stop the instant loading ends. Escalating only to confirm Martin accepts a spinning ring at all vs. a static "Loading…" — the app currently has neither, so this is a genuine new decision, not a spec conflict.
7. **`main/index.ts` importing renderer code.** `terminalTheme.ts` lives in the renderer; the main process needs `WINDOW_BG`. **Resolved:** extract the two flat constants into a tiny shared `src/shared/colors.ts` both processes import, so main has no renderer dependency. Noted so Phase 1's bg-fix doesn't create a bad import edge.
</content>
</invoke>
