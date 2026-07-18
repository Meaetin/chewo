# 05 — Motion

Status: DRAFT — awaiting review
Persona: Motion Designer · Inputs: `00-brief.md` (locked), `02-art-direction.md` ("Kiln", §2/§8/§9), `03-visual-design.md`, `04-design-system.md`
Job: make the small, deliberately minimal amount of motion in Kiln feel intentional, cohesive, and premium — and define the physics precisely enough that every future implementer moves things the same way. **Restraint is the assignment.** This doc adds no new animated moments beyond the AD's five sanctioned ones plus the functional state-change transitions the AD's own rules already imply. Where I permit something the AD didn't enumerate, it is justified as *confirming a state change*, never decoration. Where I deny myself something tempting, I say so.

This doc invents no colors, sizes, or radii — those trace to `02`/`03`/`04`. It adds one new token family: **motion** (durations + curves), living in the primitive layer of the DS token sheet (`04` §1).

---

## 1. Motion principles

Five principles, derived straight from the calm-first personality hierarchy (`00` §"Personality hierarchy"). When two conflict, the earlier wins — same precedence rule as the personality layers.

1. **Motion confirms a state change; it never announces.** Every animation is the *echo* of something that actually happened (a selection, an open, a completion). If nothing changed state, nothing moves. — *Why:* calm is the base register; motion that performs for attention breaks the "nothing shouts" litmus (`02` §1).
2. **The room is still unless something actually happened.** At rest, zero pixels are in motion — with exactly one sanctioned exception (the recording breath) and one argued extension (process-bound loading, §5). Idle is silence. — *Why:* the north star is "several things quietly running" (`02` §2); ambient motion would make the room chatter.
3. **Small travel reads expensive; big travel reads theatrical.** Micro-feedback moves ≤2px (really: color and opacity only); panels and overlays move ≤8px; nothing in the app ever translates more than 8px. Distance is led by opacity, not displacement. — *Why:* premium products under-move; the studio/craft layer is "precise, tactile," not swooping.
4. **Fast in, faster out; get out of the way.** Entrances may take a beat to feel intentional (≤320ms); exits are quicker (≤200ms) so dismissed things don't linger. Nothing exceeds the 400ms cap, and only one moment reaches it. — *Why:* editorial hierarchy means the content is the point; chrome that overstays its welcome competes with the type.
5. **One physics, everywhere.** Four curves and a handful of durations cover the whole app; the same interaction class always uses the same pair. A hover feels like a hover on every surface. — *Why:* success criterion #4 — "motion exists and is felt but never noticed"; cohesion is what makes it invisible.

---

## 2. Easing & duration system

Ready to paste into `:root` in the DS primitive layer (`04` §1.2), directly under the elevation tokens. Curves and durations are primitives; the semantic aliases beneath them are what components actually name.

### 2.1 Curves

| Token | cubic-bezier | Character | Used by |
|---|---|---|---|
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Calm, near-symmetric workhorse | Hover, press, focus ring, selection, tab switch, workflow cross-fade, color/opacity changes |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Decisive decelerate — arrives and settles | Entrances: panel/find-bar/rail open, modal in, toast in, content fade-in, capabilities takeover |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Accelerate away | Exits: panel/rail close, modal out, toast out |
| `--ease-settle` | `cubic-bezier(0.34, 1.26, 0.64, 1)` | Gentle single overshoot (~+8%), warm not bouncy | **Playful moments only:** empty-state entrance, first-run card, agent-completion bloom |
| `--ease-breath` | `cubic-bezier(0.37, 0, 0.63, 1)` | Sine-like in-out | The two loops only: recording breath, working-pulse |

`--ease-settle` is the ONLY curve that overshoots. It is gated to the sanctioned playful moments; using it on functional UI is a bug (it would make chrome "perform").

### 2.2 Durations

| Token | Value | Class of interaction |
|---|---|---|
| `--dur-instant` | `80ms` | Press/active feedback, focus-ring appear, tooltip fade |
| `--dur-fast` | `140ms` | Hover feedback, selection change, tab chip, all exits |
| `--dur-base` | `200ms` | Content fade-in (AD cap ≤200ms), panel/modal/toast entrance |
| `--dur-slow` | `320ms` | Workflow switch cross-fade, empty-state + first-run entrance |
| `--dur-bloom` | `400ms` | **Agent-completion bloom ONLY** — the single animation at the 400ms cap |
| `--period-breath` | `2000ms` | Recording breath loop period (AD's one sanctioned loop) |
| `--period-work` | `1400ms` | Working-pulse loop period (loading; the argued extension, §5) |

**The 400ms cap governs one-shot transition length.** `--dur-bloom` is the single moment that reaches it. Loop *periods* (`--period-breath`, `--period-work`) are not one-shot durations — they are the sanctioned continuous exceptions and are deliberately named differently so no one mistakes them for a transition budget.

### 2.3 Semantic motion aliases

Components name these, not the primitives (mirrors the DS `primitive → semantic → component` law, `04` §0):

```css
  /* ---- Motion primitives (this doc) ---- */
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out:      cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in:       cubic-bezier(0.4, 0, 1, 1);
  --ease-settle:   cubic-bezier(0.34, 1.26, 0.64, 1);
  --ease-breath:   cubic-bezier(0.37, 0, 0.63, 1);

  --dur-instant: 80ms;  --dur-fast: 140ms;  --dur-base: 200ms;
  --dur-slow: 320ms;    --dur-bloom: 400ms;
  --period-breath: 2000ms; --period-work: 1400ms;

  /* ---- Semantic motion aliases (components consume these) ---- */
  --motion-hover:     var(--dur-fast) var(--ease-standard);
  --motion-press:     var(--dur-instant) var(--ease-standard);
  --motion-focus:     var(--dur-instant) var(--ease-standard);
  --motion-select:    var(--dur-fast) var(--ease-standard);
  --motion-overlay-in:  var(--dur-base) var(--ease-out);
  --motion-overlay-out: var(--dur-fast) var(--ease-in);
  --motion-content:   var(--dur-base) var(--ease-out);
  --motion-workflow:  var(--dur-slow) var(--ease-standard);
```

---

## 3. Complete motion inventory

Every place motion is permitted. Rows above the rule are **functional transitions** — allowed because each confirms a state change (AD §9's own carve-out: "no animation *without* a state change"), not because they're decorative. Rows below are the five playful moments (§4). Calm constraint column is binding: it names the property ceiling.

| Interaction | Trigger | Animates | Duration | Easing | Calm constraint |
|---|---|---|---|---|---|
| **Row / button hover** | pointer enters | `background-color`, icon/text `color` | `--dur-fast` | `--ease-standard` | Color/opacity only. No translate, no scale. |
| **Press / active** | pointer down | `background-color` → pressed token; primary button optional `translateY(1px)` | `--dur-instant` | `--ease-standard` | ≤1px travel. Tactility via color, not bounce. |
| **Focus ring appear** | keyboard/programmatic focus | `box-shadow` (`--focus-ring`), `border-color` → `--accent` | `--dur-instant` | `--ease-standard` | Shadow spread + color only. No layout, no glow pulse. |
| **Selection change** | row becomes selected | new row: `--clay-wash` fill in + 2px bar via `opacity`/`scaleY`; old row: fade out | `--dur-fast` | `--ease-standard` | Opacity-led. **No sliding shared bar** between rows — the bar appears in place; travel would "announce." |
| **Tab switch** | active tab changes | tab chip `background-color`, label `color`; canvas content cross-fade | chip `--dur-fast`, content `--dur-base` | `--ease-standard` | No sliding underline/indicator. Chip color only; content opacity only. |
| **Find bar open/close** | ⌘F / Esc | `opacity` + `translateY(-4px→0)` | in `--dur-base` / out `--dur-fast` | `--ease-out` / `--ease-in` | ≤4px, opacity-led. |
| **Notes chat rail open/close** | toggle | `opacity` + `translateX(8px→0)` on a fixed-width panel | in `--dur-base` / out `--dur-fast` | `--ease-out` / `--ease-in` | ≤8px. Translate a fixed-size element — never animate `width` (layout thrash). |
| **Capabilities takeover** | open manager | `opacity` + `translateY(8px→0)` | `--dur-base` | `--ease-out` | ≤8px, opacity-led. Full-surface view swap. |
| **Modal enter** | open | backdrop `opacity 0→1` (`rgba(0,0,0,0.55)`); dialog `opacity` + `translateY(8px→0)` + `scale(0.98→1)` | `--dur-base` | `--ease-out` | ≤8px; scale ≥0.98. Backdrop fade separates the layer (elevation = light, `02` §5). |
| **Modal exit** | close / Esc | dialog `opacity→0` + `translateY(0→4px)`; backdrop fade | `--dur-fast` | `--ease-in` | Faster out. No scale-down flourish. |
| **Toast enter** | event | `opacity` + `translateY(8px→0)` from bottom | `--dur-base` | `--ease-out` | ≤8px. The `--accent` identity is the 3px bar (`03` §4), not motion. |
| **Toast exit** | auto-dismiss / close | `opacity→0` only | `--dur-fast` | `--ease-in` | Fade only — no translate, so a leaving toast doesn't pull the eye. |
| **Tooltip** | hover-intent delay `450ms`, then show | `opacity 0→1` (no translate) | `--dur-instant` | `--ease-standard` | Delay is a timeout, not motion. Fade only; hide fades in `--dur-instant`. |
| **Workflow switch (Code⇆Notes)** | segmented control | main content cross-fade `opacity`; switcher active state `background`/icon color | content `--dur-slow`, switcher `--dur-fast` | `--ease-standard` | The one `--dur-slow` UI transition (largest context change). Opacity-led, **no translate** on a full surface (avoids motion sickness). |
| **Content fade-in on launch** | window ready, state restored | `opacity 0→1` on the content wrapper, once | `--dur-base` (≤200, AD) | `--ease-out` | Single fade. **No stagger** (AD §2: "no motion on launch beyond a ≤200ms fade-in"). Terminal canvas fades once on mount, never transitioned thereafter. |
| — | | | | | |
| **(a) Empty-state entrance** | surface becomes empty / first paint | glyph `scale(0.9→1)` + container `opacity` + `translateY(6px→0)`; 40ms stagger glyph→headline→line | `--dur-slow` | `--ease-settle` | §4. Once on entering empty — guarded, not every re-render. |
| **(b) First-run card** | feature used first time, ever | `opacity` + `translateY(8px→0)` + `scale(0.98→1)`; dismiss fade + `translateY(0→4px)` | in `--dur-slow` / out `--dur-fast` | `--ease-settle` / `--ease-in` | §4. Fires once per feature, then never. |
| **(c) Agent-completion bloom** | long-running agent finishes | dot pseudo-ring `scale(0.6→1.8)` + `opacity(0.5→0)`; dot `scale(1→1.6→1)`; label `color` warm, hold 2s, ease back | `--dur-bloom` (400) | `--ease-settle` | §4. **The only 400ms animation.** Once. No badge count, no repeat. |
| **(d) Recording breath** | recording active | dot `opacity(1→0.55→1)` + `scale(1→1.12→1)`, infinite | `--period-breath` (2000) | `--ease-breath` | §4. **The only rest-loop.** Stops instantly (`--dur-fast`) when recording ends. |
| **(e) Copy / idle delight** | idle/empty microcopy present | **nothing** — see §4(e) | — | — | Delight here is *verbal*, not kinetic. Motion stays out. |

**Denied by design (tempting, refused):** sidebar-open stagger, list-item entrance cascade, number roll-ups on counts, skeleton shimmer, hover-lift shadows on cards, a sliding tab/selection indicator, page-turn or slide transitions between workflows, icon micro-animations (spin-on-hover), progress spinners as the default loader (§5). Each would be motion without a state change, motion >8px, or a loop at rest — all AD §9 violations.

---

## 4. The five playful moments — choreographed

These are the entire delight budget (AD §8). Each is *earned* by a real, rare state change and fires **once** (except the breath, which is bound to an ongoing state). Anything new must displace one of these, not join them.

### (a) Empty-state entrance
Trigger: a surface transitions into empty, or an empty surface first mounts. Guard so it does **not** replay on scroll/re-render.
```
t=0     container: opacity 0, translateY 6px; glyph: scale 0.90
0–320   container → opacity 1, translateY 0        (--dur-slow, --ease-settle)
        glyph     → scale 1.0 (settles ~+8% past 1, returns)
+40ms   headline fades in; +80ms  wit line fades in  (opacity only, --dur-base)
```
Total ≤400ms. The settle overshoot on the glyph is what makes it feel "set into place" like a tool laid on the bench, not slid on. Serif headline per `03` §1 (variant a).

### (b) First-run card
Trigger: first-ever use of a feature (first worktree, first dictation, first notes chat). Persisted-dismissed forever.
```
enter   opacity 0→1, translateY 8px→0, scale 0.98→1   (--dur-slow, --ease-settle)
dismiss opacity 1→0, translateY 0→4px, scale 1→0.99   (--dur-fast, --ease-in), then unmount forever
```
Slightly more presence than an empty state (8px vs 6px, adds scale) because it is a genuine one-time-ever moment and can afford to be greeted.

### (c) Agent-completion dot bloom + label warm
Trigger: a long-running agent's terminal reaches idle/completion. Fires exactly once on that transition. This is the single 400ms animation in the app. Built as **transform + opacity only** — the "glow" is a pseudo-element ring that scales and fades, never an animated `box-shadow` (paint cost).
```
Dot (::after ring, sage --live at ~0.5 alpha):
  t=0     scale 0.6, opacity 0.5
  0–400   scale 0.6→1.8, opacity 0.5→0            (--dur-bloom, --ease-settle)
Dot core (sage):
  0–180   scale 1.0→1.6      (settle peak)
  180–400 scale 1.6→1.0
Tab label:
  0–200   color --text-secondary → sage-warmed --text-primary
  hold    2000ms
  +320    color → --text-secondary                (--dur-slow, --ease-standard)
```
One bloom, one warm, then still. No bounce beyond the single settle. No count badge (AD §2/§8: "never badges with counts screaming").

### (d) Recording breath — the only rest-loop
Trigger: recording is active. The clay record dot (`--clay`, per `03` §4).
```
@keyframes breath (--period-breath 2000ms, --ease-breath, infinite):
  0%    opacity 1.00, scale 1.00
  50%   opacity 0.55, scale 1.12
  100%  opacity 1.00, scale 1.00
```
`transform` + `opacity` only. `will-change: transform, opacity` while recording; removed the instant it stops. On stop: animation removed, dot returns to solid clay / scale 1 over `--dur-fast`. This is the one animation permitted to run continuously at rest, and only while the recording state is live — the AD's explicit exception.

### (e) Copy / idle delight — deliberately motionless
AD §8.5 scopes this moment to *microcopy* ("Nothing running. The studio is quiet."). I am **denying it any animation.** Reason: an idle-delight motion would, by definition, run with no state change behind it and no natural end — i.e. a loop at rest, which principles 1–2 and AD §9 forbid. So the delight here is carried entirely by words (and the already-choreographed empty-state entrance that delivers them). If a future idle motion is ever wanted, it must displace one of the other four *and* find a way to not loop — which is why, correctly, it stays text.

---

## 5. The loading question — RESOLVED

The Design Systems pass (`04` §2.14, §5 Q6) flagged that the app has **no loading states** and asked whether a spinning ring is even acceptable in a calm, no-loop direction. This is the real gap. My call:

**No spinning ring, anywhere.** A rotating loader is the most generic "app is busy" cliché and it fights both calm-first and studio/craft. It is denied as the default loader. Instead, loading is expressed by *what kind of wait it is*, using three treatments — and I explicitly reconcile each against "nothing loops except the recording breath."

**The reconciliation.** AD §9 bans loops "except the recording breath." I read that rule's *spirit* as: no decorative loop, and no loop **at rest** (with no state behind it). A loading indicator is bound to a transient state and ends the instant loading ends — the same category as the recording breath (bound to the recording state), not the same as an idle shimmer. So I permit **exactly one** additional process-bound loop — the **working-pulse** — and I minimize it to opacity-only text and cap it at one per surface. **This is the single place I push past the AD's literal wording; it is flagged here and made revertible** (a one-token toggle drops the pulse to fully-conforming static text, §7). I take this deliberately rather than smuggling a spinner in under "state-bounded," which is what a less honest reading would do.

### Three loading treatments

| Treatment | When | Motion | Reconciliation |
|---|---|---|---|
| **No indicator → fade** | Wait is short (<~200ms) and local | Content fades in when ready (`--motion-content`) | Best case: perceived-instant, zero loader. |
| **Static skeleton** | Wait >200ms, content shape is known | `--bg-hover` blocks at real layout, **no shimmer**; cross-fade to content (`--dur-base`, `--ease-out`) on arrival | Static = no loop at all. Shimmer is banned (motion without a state change, AD §9). |
| **Mono working-pulse** | Indeterminate process the machine narrates | Literal mono status text (`--fs-xs`, `--font-mono`, `--text-tertiary`), whole line `opacity 1→0.55→1` at `--period-work` (1400ms), `--ease-breath` | The one process-bound loop. Opacity-only, one per surface, stops on completion. The "machine speaking" register (AD §2/§4). |

Skeletons and the working-pulse only appear **after a ~200ms delay** so fast operations never flash a loader (flashing a loader is itself an unwanted state change).

### Per-context mapping

| Context | Treatment | Detail |
|---|---|---|
| **Transcript load** | No indicator; skeleton if slow | Local read, usually instant → fade content in. If >200ms: 3–4 skeleton message blocks (user bubble + role-label + lines), cross-fade to real messages. |
| **Capabilities scan** | Mono working-pulse (+ skeleton rows) | "Scanning capabilities…" in mono tertiary with the pulse; skeleton rows beneath if a list is forming. Pulse stops when the scan resolves. |
| **Worktree checking** | Inline mono, in place | Button/field enters loading state: label swaps to mono "Checking…" with the working-pulse, **width held** (no reflow), control non-interactive (`aria-busy`). No ring. |
| **Notes structuring** | Mono working-pulse | Exactly the AD's blessed treatment (`02` §2, `03` §4): "Structuring…" mono `--fs-xs` `--text-tertiary`, quiet, machine voice. The pulse is the only motion. |
| **Terminal spawn** | No indicator | pty is fast and the canvas is the point; xterm fades in once on mount (`--dur-base`) and shows its own first bytes. Never a loader over a terminal. |

**Reserved, not currently used:** a **determinate bar** (2px, `--clay` fill on `--line-1` track, growing to true progress, `--ease-standard`). Only permitted where real progress exists — an indeterminate looping bar is *not* allowed (that would be a decorative loop). None of today's operations report progress, so it ships unused; it is the sanctioned pattern if one ever does.

`04` §2.14's `Spinner` primitive is therefore **retired in favor of `Skeleton` (static) + a `WorkingText` component** (mono text + optional pulse). The Button `loading` state uses `WorkingText` (label→mono status, width held), not a ring.

---

## 6. Reduced-motion contract

`@media (prefers-reduced-motion: reduce)` — the rule set below. Principle: **remove displacement and scale; keep opacity and color** (they carry meaning calmly and aren't vestibular triggers). Nothing loops.

| Element | Reduced-motion behavior |
|---|---|
| Hover / press / focus / selection / tab | Keep color/opacity transition (`--dur-fast`); drop any translate/scale. Comprehension preserved. |
| Panels, find bar, chat rail, capabilities, modal, toast | **Opacity-only** cross-fade at `--dur-fast`. No slide, no scale. Backdrop still fades. |
| Content fade-in on launch | Kept — already opacity-only. |
| Empty-state / first-run | Single opacity fade, no rise/scale, no stagger, no settle overshoot. |
| **Agent completion** | No ring, no scale. Degrades to the **label color warm** (hold 2s, fade back) — a color state change, not motion. Completion stays perceivable. |
| **Recording breath** | Breath loop removed. Recording shown by a **static solid clay dot + the running mono elapsed timer** (the timer is ticking text, not animation). State fully legible with zero motion. |
| **Working-pulse** | Pulse removed → static mono status text. Skeletons are already static. |
| Determinate bar (if used) | Instant jumps to each progress value, no eased fill. |

Global fallback (belt-and-suspenders): under reduced-motion, set `transition-duration`/`animation-duration` toward `0.01ms` app-wide, then re-enable the opacity-only cases above explicitly. Never a blanket `* { animation: none }` — that would kill the accessible recording/completion *state* cues, which must survive as color/text.

---

## 7. Implementation notes

**Technique per case:**
- **CSS transitions** for all state-driven micro-interactions and overlay enter/exit (hover, press, focus, selection, tab, panel, modal, toast, content fade, workflow). Driven by class/attribute changes; the semantic `--motion-*` aliases (§2.3) go straight into `transition`. This is the entire functional inventory.
- **CSS `@keyframes`** for the two loops (`breath`, `working-pulse`) and the one-shot bloom. The bloom is triggered by adding a class on the completion event and self-removes on `animationend` (or a fixed timeout matching `--dur-bloom`).
- **JS / spring libraries: none.** No spring runtime anywhere — the single overshoot moment is covered by `--ease-settle` as a static cubic-bezier. This is a deliberate denial: a spring lib is unjustifiable weight and a perf/consistency risk for an app this calm. Motion is 100% CSS.

**Performance rules (binding):**
- **Animate `transform` and `opacity` only.** Never animate `width`, `height`, `top`/`left`, `margin`, or any layout property — panels slide via `translate` on a fixed-size element, never by animating `width`. Never animate `box-shadow`/`filter` in a loop or the bloom — the completion "glow" is a `transform`+`opacity` pseudo-ring, not an animated shadow.
- **`will-change` discipline.** Apply `will-change: transform, opacity` only *during* an animation (add on enter, remove on `animationend`/rest). The record dot may hold it while recording (it is actively animating) and must drop it on stop. Never leave `will-change` on at-rest elements — it costs compositor memory for nothing.
- **Never transition the terminal canvas.** xterm and CodeMirror own their own rendering; app motion never animates the canvas viewport (scroll and process output must be instant). The only motion touching them is the one-shot `opacity` fade-in on mount.
- **Guard one-shot playful moments** (empty-state, first-run, bloom) so they fire on the *state transition*, not on every render/scroll — otherwise they become the "loops" the whole doc forbids.

**Where the tokens live:** motion primitives (`--ease-*`, `--dur-*`, `--period-*`) and the `--motion-*` semantic aliases sit in the same `:root` block as the DS token sheet (`04` §1), as a new subsection after elevation. They obey the same layering law: components name `--motion-*` semantics, never raw `--dur-*`/`--ease-*` — same as the color/space discipline. Loop periods are named `--period-*` (not `--dur-*`) so no one mistakes a 2s loop for a transition budget and trips the 400ms cap.

---

## Deviations & flags

1. **One extension to "nothing loops": the working-pulse (§5).** The AD's literal rule allows only the recording breath to loop. I add one process-bound opacity pulse for loading status, argued as the same category (bound to a transient state, ends on completion, not a rest-loop). Flagged, minimized to opacity-only mono text, capped one-per-surface, and **revertible via one token** to fully-conforming static text. This is the only place I push on the AD.
2. **Spinner retired (§5).** `04` §2.14 speculated a spinning ring; I deny it outright in favor of skeleton + mono working-pulse + a reserved determinate bar. Resolves the DS pass's open Q6 without introducing a rotating loader.
3. **No sliding selection/tab indicator (§3).** Tempting and common; refused because a bar traveling between rows *announces* rather than confirms. Selection appears in place. Called out because it's a place many design systems would add motion and I'm choosing not to.
4. **8px travel ceiling (my invention, §1 principle 3).** The AD gave the 400ms and no-loop caps; the ≤2px micro / ≤8px overlay displacement ceiling is mine, derived from calm-first to keep motion feeling expensive. Not in AD canon — flagged as an added constraint, not a conflict.
5. **`--dur-bloom` is the only token at the 400ms cap**, used by exactly one moment. Everything else is ≤320ms. If the completion bloom ever feels long, it can drop to `--dur-slow` with no other change.
