# 02 — Art Direction

Status: DRAFT — awaiting Martin's review
Persona: Art Director · Inputs: `00-brief.md` (locked), `01-current-state.md`, `styles.css@3e75a0e`
Direction codename: **Kiln** — fired clay, warm charcoal, a studio at night.

---

## 1. North star

Chewo should feel like a **well-lit workbench in a dark studio**: warm charcoal
surfaces like fired clay cooling, cream text like paper under a lamp, and one
terracotta ember marking wherever your hand is. It is a place where serious
work happens all day without the room ever shouting — the machines (terminals)
hum in the middle, and everything around them is quiet, tactile, and precisely
joined.

**Litmus test:** *if a screen doesn't feel like a warm room where several
things are quietly running, it's off-direction.* Corollaries: if any surface
reads blue, it's off. If anything but the ember (clay accent) asks for
attention while nothing is wrong, it's off.

---

## 2. Emotional tone by moment

Calm-first is the base register everywhere; these are the permitted shifts on
top of it.

| Moment | Feels like | Concretely |
|---|---|---|
| **Opening in the morning** | Walking into your own studio — lights already low, tools where you left them | No splash, no motion on launch beyond a ≤200ms fade-in of content. Sidebar state restored. The only color on screen: clay on the active workflow + selected row, muted live dots. |
| **Watching multiple agents run** | A quiet machine room — you can *see* activity without being addressed by it | Live state is ambient: small sage dots, faint sage tint on live rows, no pulsing while healthy. Motion only at state *changes* (agent finishes → one soft dot bloom, then still). Never badges with counts screaming, never per-agent color coding. |
| **Reading a transcript** | Reading a well-set document — editorial, paper-like | Widest measure on the app (max ~740px), most generous line-height, chrome recedes to hairlines. Role labels whisper (small caps, tertiary). This is where the editorial layer is most visible. |
| **Writing / dictating notes** | A notebook, not an IDE | Warmest surface treatment in the app; serif lesson titles (§4); the record state is the one place a slow breathing pulse is allowed (clay, 2s cycle). Structuring status is quiet mono text, not spinners. |
| **Error / destructive action** | A firm hand on your shoulder — serious, not alarmed | Ember red appears in exactly one place at a time (the destructive button or the banner, not both saturated). No red flooding, no shaking, no modals that scream. Confirmations state consequences in plain text. |

---

## 3. Color world

Everything below hangs off two hues: **clay** (~15° orange, seeded from
`#d97757`) and a neutral ramp tinted with the *same* hue at very low
saturation, so the whole app is provably one temperature. The current
`#16161e` family is blue-violet (hue ~240°) — every neutral below replaces it.
Sanity rule for any future neutral: **R > G > B** in its hex, always.

### 3.1 Warm-dark neutral ramp (8 steps)

Hue ≈ 25°, saturation 12–18%, luminance-monotonic. Steps 0–5 are fills,
6–7 are lines.

| Token | Name | Hex | Use |
|---|---|---|---|
| `--surface-0` | Kiln floor | `#171310` | Window/base background, title-bar area, workspace behind cards (Option A) |
| `--surface-1` | Char | `#1B1714` | Terminal canvas, editor canvas — the deepest *content* surface |
| `--surface-2` | Roast | `#211C17` | Sidebar, panels, tab-bar rail |
| `--surface-3` | Umber | `#272119` | Cards, modals, raised rows, tooltips |
| `--surface-4` | Bark | `#2E2720` | Hover fills |
| `--surface-5` | Walnut | `#362E25` | Pressed / selected-neutral fills (non-accent selection, e.g. segmented control) |
| `--line-1` | Seam | `#3A322A` | Default hairline borders, dividers |
| `--line-2` | Grain | `#4A4036` | Strong borders, input borders, rim-light on overlays |

Single source of truth: `--surface-1` is what xterm, CodeMirror, and the
`BrowserWindow.backgroundColor` must all consume (kills the triple-hardcoded
`#16161e`). `backgroundColor` uses `--surface-0`.

### 3.2 Text ramp

Cream, never white. `#fff` (currently ×5) is banned.

| Token | Name | Hex | Use |
|---|---|---|---|
| `--text-primary` | Cream | `#EDE6DD` | Body, titles, terminal default fg |
| `--text-secondary` | Oat | `#B9AE9F` | Secondary labels, inactive tab text |
| `--text-tertiary` | Ash | `#8A7F70` | Meta, timestamps, section headers, resting icons |
| `--text-faint` | Smoke | `#625A4F` | Placeholders, disabled — decorative only, never information-bearing |

(`--text-tertiary` on `--surface-2` ≈ 4.5:1 — the floor for any text that
carries meaning.)

### 3.3 Clay — the brand accent

Seeded from `#d97757`, hue kept at ~15°; the default step is unchanged so
existing brand equity carries over.

| Token | Name | Hex | Use |
|---|---|---|---|
| `--clay-wash` | Wash | `rgba(217,119,87,0.10)` (flattens to ≈`#33241D` on Roast) | Selected-row fill, active-tab underline zone, badge/chip backgrounds |
| `--clay-hi` | Glow | `#E08A66` | Accent *text/icons* on dark (lifted for contrast), hovered links, active icon |
| `--clay` | Clay | `#D97757` | THE accent: primary buttons, focus rings, selection markers, record dot, active workflow |
| `--clay-deep` | Fired | `#C05F3E` | Pressed/active button state, high-emphasis borders |

**On-clay text:** primary buttons are clay fill with **warm ink text
`#241610`** (`--on-clay`), not white — ~5.8:1 contrast, and it's a signature
detail (cf. Arc's filled controls). White-on-terracotta (current
`.resume-button`) fails contrast and looks stock.

**The accent rule (this kills the blue/orange inconsistency):**

> Clay means *"you are here / do this."* It marks selection, focus, the primary
> action, and active/recording states — and nothing else. Source identity
> (Claude/Codex) lives **only inside badge chips**, never on rows, borders,
> buttons, or focus states. Green lives only on live dots and live-row tints.
> One screen never shows more than one non-clay accent hue at rest.

Concretely: project-row selection (currently codex blue, `styles.css:159`) and
session/notes selection (currently `--accent-claude`) both become
`--clay-wash` fill + 2px `--clay` left bar. Input focus (currently codex blue
on some) becomes a 1px `--clay` border + soft `--clay-wash` outer glow.
`.project-row-live` orange count (`styles.css:442`) becomes sage like the dot —
one concept, one color.

### 3.4 Semantic colors (re-warmed)

Current `#e06c75 / #e5c07b / #34d399` are One-Dark-era cool picks. Replacements
sit in the Kiln temperature:

| Token | Name | Hex | Wash (10–12% on Roast) | Notes |
|---|---|---|---|---|
| `--danger` | Ember | `#E2574B` | ≈`#31201C` | Redder and hotter than clay (hue ~5° vs 15°). Because they're neighbors: danger is **never** a row-selection color, always pairs with a word or icon, and clay is **never** used on destructive controls. |
| `--warning` | Honey | `#DFA94E` | ≈`#332A1A` | Warm amber; replaces `#e5c07b` ×3 and one-offs `#ef7f88`/`#e88b92`. |
| `--live` | Sage | `#8FBC72` | ≈`#25281E` | Warm moss green replacing mint `#34d399` (mint is the coolest pixel in the current app). Still unmistakably "running". |

### 3.5 Source badges (identity, demoted)

Badges are 2-letter chips (CC / CX / SH), wash background + tinted text,
`--radius-1`, 10px semibold caps. They are the *only* place these hues exist.

| Badge | Text | Chip bg |
|---|---|---|
| Claude `CC` | `--clay-hi` `#E08A66` | `--clay-wash` |
| Codex `CX` | **Denim** `#8FA9C9` | `rgba(143,169,201,0.10)` |
| Shell `SH` | `--text-tertiary` | `--surface-4` |

Denim is `#6ba4f8` desaturated ~45% and warmed — dusty enough to sit in the
room, still instantly "the blue one" next to CC. **Deviation note:** the brief
lists `#6ba4f8` as existing identity; taming it is within the "shrinks to
badge-level" mandate, but it does change the recognizable Codex blue — see
open decisions.

---

## 4. Typography direction

Type personality: **"a quiet editor with excellent handwriting."** Hierarchy
comes from weight + spacing discipline, with one serif signature reserved for
human-authored moments.

- **UI face: system SF Pro (keep, formalize).** Verdict on bundling a humanist
  sans (Inter, Untitled-alikes): not worth it. SF Pro is genuinely good, ships
  optical sizes for free, keeps the app feeling native-macOS (an Arc trait),
  and costs 0 bytes. Character comes from *discipline*, not a font swap:
  weights limited to 400/500/600 (kill the 700 role-labels), tracking on
  small caps labels (+0.06em), and a real modular scale (Visual Designer's
  job — but kill 11.5/12.5px fractional sizes; whole pixels on an even rhythm).
- **Editorial serif: yes, tightly budgeted.** One bundled variable serif —
  **Source Serif 4** (SIL OFL, ~free warmth, slightly calligraphic italics;
  runner-up: Newsreader). It may appear in exactly three places, always ≥18px:
  1. Notes lesson titles (the title input renders serif),
  2. Empty-state headlines,
  3. First-run / feature-intro headlines.
  Never in the sidebar, tabs, transcript body, or any control. This is the
  Craft-style signature that makes Notes feel like a notebook. If Martin
  vetoes the serif, the fallback is pure scale/weight discipline — workable,
  but the app loses its one literary flourish.
- **Mono: first-class citizen, one token.** `--font-mono` used everywhere
  (kills the ~11 string literals + `TerminalPane.tsx:21`). Recommended stack:
  `'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace`.
  Default reality: **SF Mono** — native, excellent at 11–13px, free.
  Upgrade path: **Berkeley Mono** (paid, ~$75 personal) is *the* craft-era mono
  and would out-charm SF Mono in the terminal, transcript chips, and paths; the
  stack means buying it later is a font-file drop, zero code change.
  (JetBrains Mono considered and rejected: free but visually corporate; its
  personality fights "studio".) Mono is also the voice of *system status*
  (structuring steps, git branches, paths) — status text set in small mono
  tertiary reads as "the machine speaking", a deliberate register.

---

## 5. Materials & construction

The studio layer: how things are *joined*.

- **Separation = tone first, seams second, shadow last.** Adjacent regions
  separate by one surface step (sidebar Roast vs canvas Char) plus a 1px
  `--line-1` seam. In-flow elements (rows, cards, tabs) get **no shadows,
  ever** — dark-on-dark shadows are mud.
- **Elevation in the dark = light, not shadow.** True overlays (modals,
  popovers, toasts, tooltips) read as *closer to the lamp*: `--surface-3` fill,
  1px `--line-2` border, a 1px inset top **rim-light**
  (`inset 0 1px 0 rgba(255,240,225,0.05)`), and one soft ambient drop
  (`0 16px 40px rgba(0,0,0,0.45)`) whose job is separation, not decoration.
  One overlay recipe — this also forces the two modal systems to merge.
- **Radius personality: "soft shell, precise core."** Exactly four stops:
  `--radius-1: 5px` (chips, badges), `--radius-2: 7px` (buttons, inputs, rows,
  tabs), `--radius-3: 10px` (cards, panels, terminal card), `--radius-4: 14px`
  (modals only). Pill radius allowed once: the record control. The current
  3/4/5/6/7/8/10/12 chaos maps onto these; no new values.
- **Texture: one whisper of grain, optional.** A tiled 64px monochrome-noise
  data-URI at 2–3% opacity on `--surface-0` and the sidebar (`--surface-2`)
  only — never on terminal, editor, or transcript surfaces (text must sit on
  flat ground). It's the difference between "dark UI" and "material". Ship it
  behind a token so it's a one-line veto.
- **Title bar: `titleBarStyle: 'hiddenInset'` — do it.** The stock macOS bar
  over dark chrome (`index.ts:52`) is the single cheapest "considered-ness"
  win. Traffic lights float over the sidebar top; the sidebar gains a ~40px
  draggable header zone (`-webkit-app-region: drag`); the WorkflowSwitcher
  moves down into that zone, right of the lights. Window `backgroundColor`
  becomes `--surface-0` so resize flashes stay warm.

---

## 6. Iconography

Kill the glyph soup (⎇ ⛭ ⚙ ⇤ ⎘ ✦ 🔑 ⚠ …) — it renders inconsistently and
can't be styled. One library, one rule.

| Library | Personality | Coverage for us | Verdict |
|---|---|---|---|
| **Lucide** | 24-grid, adjustable stroke, rounded joins with square precision — "drafting pen" | Excellent: `terminal`, `git-branch`, `git-merge`, `folder-git-2`, `mic`, `sparkles`, `key-round`, `triangle-alert`; 1500+, tree-shakeable `lucide-react`, ISC | **Pick.** Matches studio/craft: precise but warm. |
| Phosphor | 6 weights, rounder caps, friendlier | Very good, huge set | Runner-up — reads one notch too playful for our base register (playful is seasoning, not construction). |
| Heroicons | Solid/outline, Tailwind-flavored | Weak on terminal/git concepts (~300 icons) | Out. |

**Usage rule:** default **16px, stroke 1.75**; 14px/1.75 in dense sidebar rows;
20px/1.5 in empty states and modals. Color: icons inherit text color —
`--text-tertiary` at rest, `--text-primary` on hover, `--clay` only when the
control is active/selected. Icons never carry their own hue except the live
dot (sage) and danger contexts (ember). Icon-only buttons require a tooltip
(build the one tooltip primitive; native `title=""` dies). Emoji are banned
from chrome; permitted only inside user content.

---

## 7. Terminal treatment — two options (Martin picks from HTML drafts)

Both share the **Kiln ANSI theme** (§7.3). The terminal is the hero either way.

### Option A — "Inset card" (the workbench)

The terminal is a tool *placed on* the workspace.

- Main panel background: `--surface-0` (Kiln floor).
- Terminal card: `--surface-1` fill, `--radius-3` (10px), 1px `--line-1`
  border, **no shadow** (in-flow); margins 10px left/right/bottom; xterm inner
  padding 14px. Cost: ~22px of columns — acceptable on a desktop daily driver,
  and it *frames* the canvas like a monitor bezel.
- Tab bar sits on `--surface-0` above the card; the active tab fills
  `--surface-1` and drops 1px to merge into the card's top edge (the current
  merge trick, kept — it's good), top corners `--radius-2`. The card's top
  edge runs under the tab rail so tab and canvas read as one object.
- Transcript and Capabilities render as the same card, so the main panel has
  one consistent "sheet on the bench" construction.
- Feels: crafted, spatial (Arc's floating page), makes multi-surface moments
  (terminal vs transcript) legible.

### Option B — "Full-bleed" (the dark room)

The terminal *is* the room; warmth comes from everything around and inside it.

- Canvas edge-to-edge at `--surface-1` — already warmer than today's
  `#16161e` by hue alone, which is half the fix.
- What stops it feeling like the current flat app: (1) the warm ANSI theme
  inside the canvas — the terminal's own output becomes the decoration;
  (2) generous xterm internal padding (16px — today's cramped edge is a
  flatness tell); (3) a crisp 1px `--line-1` seam against the sidebar and a
  merged active tab, so the construction is visible even without a frame;
  (4) hiddenInset title bar so the dark chrome runs to the window edge;
  (5) a 12px quiet gradient from `--surface-2` to transparent under the tab
  rail, giving the canvas a top "ceiling" without a border.
- Zero real-estate cost; maximum terminal focus; slightly less "designed" —
  it bets everything on tone and type being right.

### 7.3 Kiln ANSI-16 direction (both options)

Vibe: **"gruvbox raised in a nicer neighborhood"** — earthy, medium-contrast,
nothing fluorescent, every slot warmed to sit on Char. Indicative anchors
(Visual Designer finalizes all 16 + brights):

| Slot | Hex | Note |
|---|---|---|
| background | `#1B1714` | = `--surface-1`, single token shared with app |
| foreground | `#EDE6DD` | = `--text-primary` |
| cursor / selection | `#D97757` / clay at 25% | the ember in the machine |
| black / br-black | `#241E19` / `#5C5248` | warm, never `#000` |
| red | `#E2574B` | = `--danger` |
| green | `#8FBC72` | = `--live` |
| yellow | `#DFA94E` | = `--warning` |
| blue | `#8FA9C9` | = Denim — tamed, still readable as blue |
| magenta | `#C98AA9` | dusty rose, not purple |
| cyan | `#83B5A4` | warm sea-glass |
| white / br-white | `#D8CEC2` / `#F4EDE4` | |

Rule: ANSI slots derive from app tokens where a token exists (bg, fg, red,
green, yellow, blue) so the terminal is *provably* in the same world.

---

## 8. Playful accents budget

Playfulness is a spice rack, not a pantry. The complete allowed list:

1. **Empty states** — serif headline + one line of dry wit + a single 20px
   Lucide glyph. No illustrations, no mascots.
2. **First-run of a feature** (first worktree, first dictation, first notes
   chat) — one warm explanatory card, serif headline, dismissed forever.
3. **Agent completion** — when a long-running agent finishes, its tab dot does
   one soft sage bloom (~400ms) and its label warms for 2s. Once. No badge
   counts, no bouncing.
4. **Recording** — the clay dot breathes on a 2s cycle while recording (the
   only sustained animation in the app).
5. **Copy voice** — microcopy may be human ("Nothing running. The studio is
   quiet.") in empty/idle states only; system status stays literal mono.

Everything else — every button, row, modal, transition — stays calm. Any new
delight idea must displace one of these five, not join them.

---

## 9. Anti-patterns (never do)

- **No pure black** (`#000`) and **no stark white** (`#fff`) anywhere — floor
  is `#171310`, ceiling is `#F4EDE4`.
- **No cool grays or blue-blacks.** Any neutral where B ≥ R is off-palette.
- **No neon / high-chroma accents** — no mint `#34d399`, no electric blue.
- **No decorative gradients or glassmorphism** — the one sanctioned gradient
  is Option B's 12px tab-rail fade.
- **No shadows on in-flow elements**; elevation = rim-light recipe only.
- **No second accent semantics** — if something is highlighted and it isn't
  clay, it's a bug (badges/live dots exempt, per §3.5).
- **No animation without a state change**, nothing over 400ms, nothing that
  loops except the recording breath.
- **No emoji or unicode glyphs as UI icons.**
- **No color-only state distinction** for critical states (ghost tabs get a
  glyph + italic label, not just `opacity:.5`).
- **No new radius, spacing, or hex values outside tokens** — success criterion
  #2 in the brief is zero orphan hex.

---

## Deviations & tunings from locked decisions (flagged)

1. **Codex blue tamed to Denim `#8FA9C9`** — within the "identity shrinks to
   badges" mandate, but it alters a recognizable color. Cheap to revert.
2. **Live green replaced** (`#34d399` → sage `#8FBC72`) — the brief listed the
   old value as existing semantics with the question left open; I'm closing it
   in favor of palette coherence.
3. **Primary buttons use dark ink text on clay,** not white — a contrast +
   character call that changes the current `.resume-button` look.
4. Clay `#D97757` itself: **kept untuned.** I tested warmer/deeper variants
   mentally against Char and the seed is already right; tuning happens at the
   scale edges (Glow/Fired), not the brand step.

## Open decisions for Martin

- **Terminal Option A vs B** (§7) — deliberately unlocked; decide from HTML
  drafts.
- **Serif yes/no** (§4) — Source Serif 4 in three places, or pure sans
  discipline.
- **Berkeley Mono purchase** (§4) — optional; stack is ready either way.
- **Grain texture** (§5) — ship at 2–3% or veto; one-line toggle.
