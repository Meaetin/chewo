# Chewo Todos — SPEC-TODOS.md

**Feature:** Kanban todo workflow with voice-command control
**Platform:** macOS desktop app (Electron) — extends Chewo
**Author:** Martin
**Date:** 2026-07-19
**Status:** Draft v1 — decisions locked via Q&A 2026-07-19. **T1 (board) implemented 2026-07-19**; T2 voice next

---

## 1. Problem & Goal

Tasks come up mid-flow — while coding, while dictating notes, while away from
the keyboard — and get lost. Martin wants a Kanban board inside Chewo that can
be driven by **voice** ("che-wo, add a todo for printing out papers") via a
hotkey, with Sonnet interpreting the utterance and executing the command, plus
ordinary manual entry.

**Goal:**
- A Kanban board with four fixed columns: **Blocked | Todo | In Progress | Done**.
- Two board scopes: a **General** board (home-level, like the existing Home
  section) and **one board per project** — project-specific tasks stay with
  the project.
- **Voice control:** hotkey → dictate → local STT (existing sidecar) → Sonnet
  interprets → command executes against a board.
- **Manual control:** type-to-add, drag cards between columns, click card →
  edit modal (title / text / paste-image), Save / Cancel.

**Non-goals (v1):**
- Due dates, reminders, notifications, recurrence, assignees, sub-tasks.
- Sync / mobile / sharing.
- MCP tools for agents (phase T3, §9 — architecture must not preclude it).

---

## 2. Decisions

### 2.1 Locked (Q&A 2026-07-19)

| Question | Decision | Rejected |
|---|---|---|
| Board placement | **Third workflow segment**: Code \| Notes \| Todo (the switcher was built for this, SPEC-NOTES §4) | Panel inside code workflow; extra overlay (maybe T4) |
| Hotkey scope | **System-wide** `globalShortcut` + always-on-top HUD; **toggle** start/stop (`globalShortcut` has no key-up event, so push-to-talk is impossible) | In-app-only listener |
| Voice targeting | **Sonnet infers** the board from the utterance; unnamed → **General** | Last-viewed board; strict-name-only matching |
| Voice command breadth | **Full control**: add / move-status / edit / delete, executed immediately with an **undo toast** | Add-only; add+move-only; confirm-before-execute |
| Storage location | **`~/.chewo/todos/<scope>/`** — global dotfolder: human-greppable, survives app-data resets, readable by agents/MCP without going through the app | `userData` (buried in `~/Library/Application Support`); in-repo `.chewo/` per project (pollutes repos) |
| STT cold start | **Overlap capture with load + idle unload** (revised 2026-07-19): the hotkey opens the mic *immediately* — the sidecar buffers audio while the model loads in parallel, and transcription catches up ~2–4 s later, so perceived latency is ~0. Model stays resident **15 min after last use** (covers bursts), then a new mic-less `unload` command frees it — RAM cost between sparse uses is ~0. Same `prewarm` command fires on opening the notes recording view (load overlaps subject/topic picking). Single model shared with notes (default `large-v3-turbo`) | Always-resident prewarm at launch (~1–1.5 GB held for once-every-2 h usage — wasteful); lazy first-use load with a blocking wait (today's notes behavior); a smaller dedicated command model (`base.en` already measured ~90% on Martin's accented speech — misses land in card titles) |
| Interpreter invocation | `claude -p --model sonnet --bare --json-schema <schema>` — `--bare` skips hooks/skills/MCP/CLAUDE.md discovery for faster startup; `--json-schema` enforces the command JSON (result in `structured_output`), replacing prompt-begged JSON. Verified vs docs 2026-07-19: print mode is strictly one-shot — **no persistent stream-json input mode exists**, so per-call process cold start is unavoidable | Resident multi-turn `claude` process (unsupported); direct Anthropic API (kept as fallback — needs an API key billed separately from the CLI's subscription auth) |

### 2.2 Defaults pending veto

| # | Question | Proposed default |
|---|---|---|
| Q6 | Done-column growth | Unbounded in v1; "Clear done" button. Auto-archive is T4 |
| Q7 | Ordering within a column | Any drop (including same-column) inserts **at top**; no fine-grained reordering in v1 |
| Q8 | Card face | Title always; if the card has text/images, show small indicator icons (no thumbnails on the card face in v1) |
| Q9 | Drag implementation | Hand-rolled pointer-event drag (dependency-light, requirements are simple). Fallback: dnd-kit if hand-rolling fights us |
| Q10 | Wake word "che-wo" | Cosmetic only — the hotkey is the trigger; Sonnet is told to ignore a leading wake word. No always-on listening |

---

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron app                                                          │
│  ┌──────────────────┐  ┌──────────────────────────────────────────┐  │
│  │ WorkflowSwitcher │  │ Main panel (workflow: code|notes|todo)    │  │
│  │ [Code|Notes|Todo]│  │  todo: BoardView (4 columns, dnd, modal)  │  │
│  └──────────────────┘  │  sidebar: scope list (General + projects) │  │
│                        └──────────────────────────────────────────┘  │
│  ┌─────────────┐  floating HUD window (voice capture, always-on-top) │
│  └─────────────┘                                                     │
│         main process                                                  │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐  │
│  │ globalShortcut│ │ STT sidecar    │  │ command interpreter      │  │
│  │ toggle capture│ │ (shared with   │  │ claude -p --model sonnet │  │
│  └──────┬───────┘  │  notes, stt.ts)│  │ --output-format json     │  │
│         │          └───────┬────────┘  └───────────┬──────────────┘  │
│         └── start/stop ────┘        transcript + board snapshot in,   │
│                                     structured command JSON out       │
│                    todos store (main): userData/todos/<scope>/…       │
│                    board.json + assets/<uuid>.png                     │
└──────────────────────────────────────────────────────────────────────┘
```

Follows existing Chewo patterns: renderer owns state, main persists and
pushes changes; STT sidecar reused via `src/main/stt.ts`; headless Sonnet
exactly like `notes-chat.ts` / `structure.ts` (`claude -p --model sonnet`,
env scrubbed via `buildPtyEnv`).

---

## 4. Data model & storage

```
~/.chewo/todos/
  general/
    board.json
    assets/9f2c….png
  p-<slug>-<hash8>/          # slug + hash of project path, stable per project
    board.json
    assets/
```

```ts
type TodoStatus = 'blocked' | 'todo' | 'in-progress' | 'done'

interface TodoCard {
  id: string                 // uuid
  title: string              // required, the only mandatory field
  text?: string              // plain text / light markdown
  images?: string[]          // filenames under assets/, pasted into the modal
  createdAt: string          // ISO
  updatedAt: string
}

interface BoardFile {
  version: 1
  columns: Record<TodoStatus, string[]>   // ordered card ids, index 0 = top
  cards: Record<string, TodoCard>
}
```

- Column order is the array — "drop at top" = `unshift`. Status is derived
  from which column array holds the id (no duplicated `status` field to drift).
- Images: pasted `image/*` clipboard data written to `assets/` as PNG,
  referenced by filename. Deleting a card deletes its assets.
- All reads/writes go through main (`todos:*` IPC); main pushes
  `todos:changed` after every mutation (voice commands mutate from main, so
  the renderer must render from pushed state, not local optimism).
- MCP-readiness: the store module in main exposes plain functions
  (`listBoards`, `getBoard`, `addCard`, `moveCard`, `updateCard`,
  `deleteCard`) that both IPC handlers and future context-bridge tools call.

---

## 5. Board UI

- **Scope switcher** in the sidebar (todo mode): General on top, then
  projects (same list as the coding sidebar's sections). Selecting a scope
  loads that board.
- **Four fixed columns**: Blocked, Todo, In Progress, Done — each with a
  count badge and its own scroll.
- **Card face**: title only, plus small indicators when text/images exist
  (Q8). Emerald accent on hover per the Graphite+Emerald direction
  (`design/06-chosen-direction.md`).
- **Drag & drop**: cards draggable between (and within) columns; a valid
  drop inserts at the **top** of the target column; dropping outside any
  column animates the card back and changes nothing. Column highlights while
  a drag hovers over it.
- **Card modal** (click card): title input, text area, pasted images shown
  as thumbnails (click to remove). **Save** commits, **Cancel** discards —
  no autosave, this is the one place in Chewo with explicit save semantics.
- **Manual add**: an input at the top of each column (`+ Add` → inline
  input, Enter commits title-only card at top, Esc cancels).
- Styling in `styles.css`, BEM-ish (`.todo-board`, `.todo-column`,
  `.todo-card`, `.todo-card-modal`), token architecture from `design/04`.

---

## 6. Voice command flow

1. **Hotkey** (default `⌥⇧Space`, configurable in settings; pending Q2)
   toggles capture. Registered via Electron `globalShortcut` in main.
2. On start: capture begins **immediately** — the sidecar opens the mic and
   buffers samples while the model loads in parallel (if not already
   resident); transcription catches up a few seconds later. Protocol grows
   `{"cmd":"prewarm","model":…}` (load without touching the mic) and
   `{"cmd":"unload"}`; main unloads after **15 min idle**. Main shows the
   **HUD** — a small frameless always-on-top window with level meter and
   live transcript (confirmed solid / tail dimmed, same rendering as the
   notes recording view). Works while Chewo is in the background.
3. Hotkey again (or HUD click, or Esc) stops capture → `final` transcript.
4. Main runs the **interpreter**: `claude -p --model sonnet --bare
   --output-format json --json-schema <command schema>` with a prompt
   containing (a) the transcript, (b) a compact snapshot of all boards
   (scope names + card ids/titles/columns). The schema-enforced
   `structured_output` is one of:

```json
{ "action": "add",    "scope": "general", "title": "Print out papers", "text": null }
{ "action": "move",   "scope": "chewo",   "cardId": "…", "to": "done" }
{ "action": "edit",   "scope": "chewo",   "cardId": "…", "title": "…", "text": "…" }
{ "action": "delete", "scope": "general", "cardId": "…" }
{ "action": "none",   "reason": "could not understand" }
```

5. Main validates against the store (unknown scope/card → `none` + error
   toast), executes, pushes `todos:changed`, and the HUD shows the result
   ("Added to General → Todo") with an **Undo** button (pending Q4), then
   auto-dismisses.
6. Interpreter guardrails: JSON-only output, temperature-free single pass,
   one command per utterance in v1 ("add A and B" → T4). Leading wake word
   ("che-wo") stripped/ignored by the prompt.
7. **Conflict rule:** if a notes recording is live, the todo hotkey is
   rejected with a HUD message (one sidecar, one mic consumer at a time).

---

## 7. Manual entry

Everything voice can do, the UI can do: add via column inputs, move via
drag, edit via modal, delete via modal (with confirm) — no feature is
voice-only, so the board is fully usable with STT off or the sidecar
unbuilt.

---

## 8. Scopes: General + per-project

- **General** = home-level board, mirrors the existing Home section concept
  (`src/shared/projects.ts` — Home is a section like any project).
- **Project boards** are keyed by project path (slug+hash, §4). Removing a
  project from Chewo keeps its board files (cheap; revisit in T4).
- Voice targeting per Q3: explicit project name in the utterance wins;
  otherwise General.

---

## 9. Phase T3 — MCP (later)

Add tools to `packages/context-bridge/src/server.ts` (the sanctioned
extensibility point, SPEC.md §4.4), thin wrappers over the store module:
`todos_list(scope?)`, `todo_add`, `todo_update`, `todo_move`, `todo_delete`.
Coding agents can then file and complete todos ("add a todo to fix the flaky
test"). No new server, no new transport.

---

## 10. Build order

- **T1 — Board (no voice):** store module + `todos:*` IPC + `todos:changed`
  push; third workflow segment; scope switcher; 4-column board; drag & drop;
  card modal with image paste; manual add; settings field for hotkey
  (unused yet).
- **T2 — Voice:** sidecar capture-before-ready buffering + `prewarm`/
  `unload` protocol commands + 15-min idle timer in main (standalone
  improvement — ship first; notes recording view prewarms on open);
  `globalShortcut` toggle + HUD window; sidecar conflict rule; Sonnet
  interpreter (`--bare --json-schema`) + validation + undo toast.
- **T3 — MCP:** context-bridge todo tools over the same store module.
- **T4 — Polish:** done-column auto-archive; multi-command utterances;
  board search/filter; project-removal cleanup; maybe card thumbnails.

---

## 11. Risks & open questions

- **Interpreter latency:** `claude -p` pays process cold start per call, and
  no resident/daemon mode exists (verified 2026-07-19 — print mode is
  one-shot; multi-turn means `--continue` with a fresh process). `--bare`
  trims discovery overhead; STT prewarm removes the model-load wait; the
  remaining floor is CLI boot + one Sonnet round trip, est. 2–4 s with the
  HUD showing "Thinking…". If that still grates, the fallback is the direct
  Anthropic API for this one call — deliberately diverging from the
  headless-claude pattern, and requiring an API key billed separately from
  the CLI's subscription auth.
- **Capture-before-ready is a sidecar change:** WhisperKit's
  `AudioProcessor` can start independently of model load, but the ported
  confirm-and-seek loop assumes the model exists — it must queue samples
  and start decoding on ready. Verify early in T2 that buffered-then-live
  transcription doesn't confuse the confirm logic. Failure mode to test:
  hotkey → speak → stop *before* the model finishes loading (short
  command) — the sidecar must still transcribe the buffer and emit `final`.
- **Model residency:** `large-v3-turbo` holds ~1–1.5 GB while loaded; the
  15-min idle unload bounds this. If a lighter always-ready option is ever
  wanted, `small.en` (~600–800 MB) is the floor worth considering —
  `base.en` was already measured at ~90% on accented speech in the
  prototype (SPEC-NOTES §2), and STT misses land verbatim in card titles.
- **STT accuracy on short utterances:** commands are 5–15 words with no
  context; proper nouns (project names) may mis-transcribe. Mitigation:
  Sonnet gets the real scope list and fuzzy-matches ("chew oh" → chewo).
- **Global hotkey collisions:** `⌥⇧Space` may clash with user apps —
  configurable from day one, and registration failure surfaces a toast.
- **HUD window focus stealing:** the HUD must never take focus from the
  frontmost app (`focusable: false`, `alwaysOnTop`) or dictating over other
  apps breaks their state.
- **`claude -p` JSON stability:** same internal-schema risk as KNOWN-ISSUES
  #1 — isolate parsing in one adapter module next to the notes-chat parser.
- Open: everything in §2.

---

## 12. Verification (end of each phase)

- **T1:** create cards by typing in General and a project board; drag a card
  through all four columns and confirm top-insert + persistence across app
  restart; drop a card outside any column and confirm no-op; paste an image
  in the modal, Save, reopen and see it; Cancel discards edits.
- **T2:** with Chewo in the background, hit the hotkey, say "che-wo, add a
  todo for printing out papers", confirm a card lands at top of General →
  Todo and the HUD reports it; say "move printing papers to done" and
  confirm the move; say gibberish and confirm a graceful `none` toast; hit
  Undo and confirm reversal; start a notes recording and confirm the todo
  hotkey is rejected.
- **T3:** from a coding agent terminal, call `todo_add` via context-bridge
  and watch the card appear live on the board.
