# Chewo Todos — SPEC-TODOS.md

**Feature:** Kanban todo workflow with voice-command control
**Platform:** macOS desktop app (Electron) — extends Chewo
**Author:** Martin
**Date:** 2026-07-19
**Status:** Draft v1 — decisions locked via Q&A 2026-07-19. **T1 (board) implemented 2026-07-19**, **T2 (voice) 2026-07-19**, **T3 (MCP) 2026-07-20**, **T4 (polish) 2026-07-20**. Drag-to-run (§10, phase T5) specced via Q&A 2026-07-20

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
- **Drag-to-run:** drop a card on a run strip → an interactive Claude Code
  session spins up in the card's scope with the card's title / text /
  images as the already-submitted prompt (§10).

**Non-goals (v1):**
- Due dates, reminders, notifications, recurrence, assignees, sub-tasks.
- Sync / mobile / sharing.
- MCP tools for agents (phase T3, §9 — architecture must not preclude it).

---

## 2. Decisions

### 2.1 Locked (Q&A 2026-07-19; drag-to-run rows 2026-07-20)

| Question | Decision | Rejected |
|---|---|---|
| Board placement | **Third workflow segment**: Code \| Notes \| Todo (the switcher was built for this, SPEC-NOTES §4) | Panel inside code workflow; extra overlay (maybe T4) |
| Hotkey scope | **System-wide** `globalShortcut` + always-on-top HUD; **toggle** start/stop (`globalShortcut` has no key-up event, so push-to-talk is impossible). Default **`⌘.`** (Martin's pick 2026-07-19 — note it shadows Xcode/Safari "stop" while Chewo runs). The hotkey is a **universal mic toggle**: during a live notes recording it stops that dictation instead of starting a voice command | In-app-only listener; `⌥⇧Space` (first default); busy-rejection during notes recording (replaced by stop-it-instead) |
| Voice targeting | **Sonnet infers** the board from the utterance; unnamed → **General** | Last-viewed board; strict-name-only matching |
| Voice command breadth | **Full control**: add / move-status / edit / delete, executed immediately with an **undo toast** | Add-only; add+move-only; confirm-before-execute |
| Storage location | **`~/.chewo/todos/<scope>/`** — global dotfolder: human-greppable, survives app-data resets, readable by agents/MCP without going through the app | `userData` (buried in `~/Library/Application Support`); in-repo `.chewo/` per project (pollutes repos) |
| STT cold start | **Overlap capture with load + idle unload** (revised 2026-07-19): the hotkey opens the mic *immediately* — the sidecar buffers audio while the model loads in parallel, and transcription catches up ~2–4 s later, so perceived latency is ~0. Model stays resident **15 min after last use** (covers bursts), then a new mic-less `unload` command frees it — RAM cost between sparse uses is ~0. Same `prewarm` command fires on opening the notes recording view (load overlaps subject/topic picking). Single model shared with notes (default `large-v3-turbo`) | Always-resident prewarm at launch (~1–1.5 GB held for once-every-2 h usage — wasteful); lazy first-use load with a blocking wait (today's notes behavior); a smaller dedicated command model (`base.en` already measured ~90% on Martin's accented speech — misses land in card titles) |
| Interpreter invocation | `claude -p --model sonnet --output-format json --json-schema <schema>` — `--json-schema` enforces the command JSON (result in `structured_output`), replacing prompt-begged JSON. Verified vs docs 2026-07-19: print mode is strictly one-shot — **no persistent stream-json input mode exists**, so per-call process cold start is unavoidable. Measured 2026-07-19: ~4–5 s end-to-end per command | `--bare` (tested 2026-07-19 on CLI 2.1.215: breaks keychain auth — "Not logged in" — so dropped); resident multi-turn `claude` process (unsupported); direct Anthropic API (kept as fallback — needs an API key billed separately from the CLI's subscription auth) |
| Drag-to-run trigger | **Dedicated drop strip** ("▶ Run in Claude") revealed only while a card drag is live; dropping there spawns the session and moves the card to In Progress. Ordinary column drags stay side-effect-free | Drop-into-In-Progress as the trigger (every bookkeeping move would launch a session); modifier-key drop (undiscoverable) |
| Drag-to-run submit | **Auto-submit**: the prompt rides as `claude`'s positional argv, so the session launches already working. User-initiated action on the user's own content — distinct from the no-auto-Enter `nudgeAgentPane` convention, which governs injecting into *running* sessions | Pre-fill without Enter (review-then-submit) |
| General-board cwd | General cards run in **Home (`~`)**, like Home-section sessions | Project picker on drop; disabling the strip on General |
| Card ↔ session link | **Move + link**: card moves to top of In Progress; renderer keeps a `cardId → termId` map for a ▶ badge that jumps to the live tab; `lastRunAt` persisted on the card. No auto-move to Done — there is no reliable "task finished" signal | Move only (no badge/jump); no side effects at all |

### 2.2 Defaults pending veto

| # | Question | Proposed default |
|---|---|---|
| Q6 | Done-column growth | **Resolved in T4 (2026-07-20):** no timer, no cap. "Clear done" became **"Archive done"** — cards move to `archive.json` in the same scope folder, keeping their images, and an "Archived N" drawer restores them to the top of Todo. The problem was never clutter, it was that clearing (and voice/MCP delete) was irreversible; a timer would make cards vanish unwatched. Deleting an archived card is the one destructive path left, behind its own confirm. Rejected: age-based auto-archive, newest-N cap |
| Q7 | Ordering within a column | Any drop (including same-column) inserts **at top**; no fine-grained reordering in v1 |
| Q8 | Card face | Title always; if the card has text/images, show small indicator icons (no thumbnails on the card face in v1) |
| Q9 | Drag implementation | Hand-rolled pointer-event drag (dependency-light, requirements are simple). Fallback: dnd-kit if hand-rolling fights us |
| Q10 | Wake word "che-wo" | Cosmetic only — the hotkey is the trigger; Sonnet is told to ignore a leading wake word. No always-on listening |
| Q11 | Post-drop navigation | On drop, switch to the **code workflow and focus the new tab** — immediate confirmation the drop worked; the board is one workflow-switch away |
| Q12 | Spawned tab label | Card title, truncated ~30 chars (same treatment as other tab labels) |
| Q13 | Prompt framing | Minimal template (§10.2): title, text verbatim, image paths. No system-y preamble — the card should read as if Martin typed it |
| Q14 | Re-running a card | Allowed; each drop spawns a fresh session, the ▶ badge points at the latest. No concurrency guard |
| Q15 | Isolation | Spawned sessions run in the **main checkout** — worktree isolation stays opt-in everywhere (house rule); a worktree variant of the strip is T5+ if ever wanted |

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
    archive.json             # cards retired from Done (T4) — restorable
    assets/
  scopes.json                # name/path → scope dir index for MCP (T3, §9)
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
  lastRunAt?: string         // ISO, set on drag-to-run (§10); additive, version stays 1
}

interface BoardFile {
  version: 1
  columns: Record<TodoStatus, string[]>   // ordered card ids, index 0 = top
  cards: Record<string, TodoCard>
}

interface ArchiveFile {                   // T4
  version: 1
  cards: Array<TodoCard & { archivedAt: string }>   // newest first
}
```

- Column order is the array — "drop at top" = `unshift`. Status is derived
  from which column array holds the id (no duplicated `status` field to drift).
- Images: pasted `image/*` clipboard data written to `assets/` as PNG,
  referenced by filename. Deleting a card deletes its assets — but
  **archiving never does**, so a restore is lossless (T4).
- All reads/writes go through main (`todos:*` IPC); main pushes
  `todos:changed` after every mutation (voice commands mutate from main, so
  the renderer must render from pushed state, not local optimism).
- The store module (`src/shared/todos-store.ts` since T3) exposes plain
  functions — `loadBoard`, `addCard`, `moveCard`, `updateCard`, `deleteCard`,
  `archiveDone`, `restoreArchived`, `deleteArchived`, `deleteScope` — that
  IPC handlers, voice commands, and context-bridge MCP tools all call.

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
- **Filter** (T4): a search box in the board header narrows the current
  board's four columns by title + text, case-insensitive substring. Column
  counts read `matches/total` while filtering; Esc or ✕ clears. Deliberately
  scoped to the visible board — a cross-scope result list is a second UI for
  a board that holds tens of cards, not thousands. Committing a new card
  clears the filter, since a non-matching card would otherwise vanish on
  save. The archive is not searched.
- **Archive** (T4): header shows "Archive done" while Done has cards, and
  "Archived N" once anything is archived. The drawer lists archived cards
  newest-first with **Restore** (back to the top of Todo, images intact) and
  a two-step **Delete**; "Delete all" is likewise two-step. It closes itself
  when the last card leaves.
- Styling in `styles.css`, BEM-ish (`.todo-board`, `.todo-column`,
  `.todo-card`, `.todo-card-modal`), token architecture from `design/04`.

---

## 6. Voice command flow

1. **Hotkey** (default `⌘.`, configurable via `todoHotkey` in projects.json)
   toggles capture; during a live notes recording it stops that dictation
   instead. Registered via Electron `globalShortcut` in main.
2. On start: capture begins **immediately** — the sidecar opens the mic and
   buffers samples while the model loads in parallel (if not already
   resident); transcription catches up a few seconds later. Protocol grows
   `{"cmd":"prewarm","model":…}` (load without touching the mic) and
   `{"cmd":"unload"}`; main unloads after **15 min idle**. Main shows the
   **HUD** — a small frameless always-on-top window with level meter and
   live transcript (confirmed solid / tail dimmed, same rendering as the
   notes recording view). Works while Chewo is in the background.
3. Hotkey again (or HUD click, or Esc) stops capture → `final` transcript.
4. Main runs the **interpreter**: `claude -p --model sonnet
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
6. Interpreter guardrails: schema-enforced JSON, single pass, and a
   **command list** — one utterance can carry several actions ("delete A
   and B", "add X and mark Y done"), executed in order; a failed item shows
   an inline ✗ line and the rest still run; **Undo reverts every scope the
   utterance touched** (pulled forward from T4, 2026-07-19). Leading wake
   word ("che-wo") stripped/ignored by the prompt.
7. **Mic ownership:** one sidecar, one consumer. If a notes recording is
   live, the hotkey acts as a universal toggle and stops that dictation.

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
  project from Chewo **keeps its board files by default**; the remove confirm
  offers "Also delete its todo board (N cards)", unchecked (T4). The confirm
  moved from `window.confirm` into the settings modal to carry that checkbox.
- Voice targeting per Q3: explicit project name in the utterance wins;
  otherwise General.

---

## 9. Phase T3 — MCP (implemented 2026-07-20)

Tools in `packages/context-bridge/src/server.ts` (the sanctioned
extensibility point, SPEC.md §4.4), thin wrappers over the store module:
`todos_list(scope?, all?)`, `todo_add`, `todo_update`, `todo_move`,
`todo_delete`. Coding agents can file and complete todos ("add a todo to fix
the flaky test"). No new server, no new transport.

Three things T3 needed beyond the wrappers:

- **The store had to leave `src/main`.** It never used Electron at runtime,
  so it moved to `src/shared/todos-store.ts` with a commit-listener seam;
  `src/main/todos.ts` is now just that store plus the `todos:changed` push.
  The MCP server, running in the CLI's process, imports the same functions —
  one code path for drag, voice, and agent.
- **Scope resolution without `userData`.** The project list lives in
  Electron's app data, unreachable from the CLI's process, and board dirs
  (`p-<slug>-<hash8>`) don't carry a path. So main mirrors the list to
  `~/.chewo/todos/scopes.json` (startup + every `projects:save`), and
  `src/shared/todo-scopes.ts` resolves a name/dir/path — or, when the caller
  omits `scope`, the CLI session's cwd — to a board. Paths are `realpath`'d
  on both sides: `process.cwd()` is resolved (`/private/var/…`) while a
  recorded project path may not be, and the raw strings would never match.
- **Live board.** Out-of-process writes can't fire the in-process push, so
  main watches the todos root (`watchTodosStore`) and pushes `todos:changed`
  per scope, debounced 250 ms.

---

## 10. Drag-to-run: card → Claude session (phase T5)

Drop a card on a dedicated run strip and Chewo spins up an **interactive
Claude Code session** in the card's scope with the card's content as the
already-submitted prompt. Decisions locked via Q&A 2026-07-20 (§2.1),
defaults Q11–Q15 (§2.2).

### 10.1 UX flow

1. Starting a card drag (existing `application/x-chewo-card` payload,
   `TodoBoard.tsx`) reveals a **drop strip** above the columns — emerald
   accent, highlights on hover exactly like columns do; hidden when no drag
   is live. Label names the target so there are no surprises:
   - project board → "▶ Run in Claude — <project name>"
   - General board → "▶ Run in Claude — Home (~)"
2. On drop:
   - The card moves to the **top of In Progress** (normal move semantics,
     `todos:*` IPC), and `lastRunAt` is stamped.
   - The renderer resolves scope → `{cwd, projectId}` (project board →
     project path/id; General → `homedir`/null) and calls `openTerminal`
     with the composed prompt (§10.2) — same defaults as `newTerminal`
     (permission mode, env scrub), **no worktree** (Q15).
   - The app switches to the **code workflow** and focuses the new tab
     (Q11); tab label = truncated card title (Q12).
3. While the spawned terminal is alive, the card face shows a small
   **▶ badge**; clicking it jumps to that tab. This link is renderer state
   only (`cardId → termId` map) — gone after app restart, and that's fine
   for v1 (§12).
4. Re-dropping the same card spawns a fresh session; the badge tracks the
   latest (Q14). Dropping outside strip and columns stays a no-op.

### 10.2 Prompt composition

Minimal, no preamble (Q13) — the prompt should read as if typed:

```
Todo: <title>

<text, verbatim, if present>

Reference images (read these files):
- ~/.chewo/todos/<scope>/assets/<uuid>.png
```

- **Images ride as absolute file paths** — cards' images are already real
  PNGs on disk (§4), and Claude Code reads image paths it finds in a
  prompt. No base64, no clipboard tricks.
- The assets dir lives outside the project cwd, so when the card has
  images the spawn adds `--add-dir ~/.chewo/todos/<scope>/assets` —
  otherwise the session's first Read of them hits a permission prompt.

### 10.3 Plumbing

- `CreateTerminalOptions` (`terminals.ts`) grows `initialPrompt?: string`
  and `extraDirs?: string[]`. `buildCommand()` appends `--add-dir` flags
  and the prompt as a **positional argv** for `source: 'claude'` —
  `claude <flags> '<prompt>'` starts the interactive REPL with the prompt
  submitted. That is the whole auto-submit mechanism: no post-spawn pty
  writes, no synthetic Enter.
- **Escaping is the critical detail:** the command runs through
  `zsh -il -c`, so the prompt must be strictly single-quoted
  (`'` → `'\''`; newlines are safe inside single quotes). One
  `shellQuote()` helper next to `buildCommand`, unit-tested against
  quotes, newlines, backticks, and `$(…)` in card text — a quoting bug
  here executes card content as shell.
- Thread `initialPrompt`/`extraDirs` through `preload` `createTerminal`
  and `openTerminal` (`App.tsx`) untouched — the renderer composes the
  prompt (it has the board + scope), main only quotes and spawns.
- Relationship to the "no stdin injection" rule (SPEC.md): that rule keeps
  agent-to-agent context out of ptys; this is a user-initiated launch of
  the user's own content via argv. The `nudgeAgentPane` no-auto-Enter
  convention governs *running* sessions and is untouched.

---

## 11. Build order

- **T1 — Board (no voice):** store module + `todos:*` IPC + `todos:changed`
  push; third workflow segment; scope switcher; 4-column board; drag & drop;
  card modal with image paste; manual add; settings field for hotkey
  (unused yet).
- **T2 — Voice:** sidecar capture-before-ready buffering + `prewarm`/
  `unload` protocol commands + 15-min idle timer in main (standalone
  improvement — ship first; notes recording view prewarms on open);
  `globalShortcut` toggle + HUD window; sidecar conflict rule; Sonnet
  interpreter (`--json-schema`) + validation + undo toast.
- **T3 — MCP:** context-bridge todo tools over the same store module. ✅
- **T4 — Polish:** archive-on-clear + archive drawer; board filter;
  opt-in project-removal cleanup. ✅ Card thumbnails dropped — Q8's indicator
  icons keep card heights even, which matters more at four columns.
- **T5 — Drag-to-run (§10):** `shellQuote` + `initialPrompt`/`extraDirs`
  in `terminals.ts` → preload → `openTerminal`; drop strip in
  `TodoBoard.tsx`; move-to-In-Progress + `lastRunAt`; ▶ badge +
  jump-to-tab. Independent of T2–T4 — can ship next.

---

## 12. Risks & open questions

- **Interpreter latency:** `claude -p` pays process cold start per call, and
  no resident/daemon mode exists (verified 2026-07-19 — print mode is
  one-shot; multi-turn means `--continue` with a fresh process). `--bare`
  would trim discovery overhead but breaks keychain auth (CLI 2.1.215) —
  retest on future CLI updates. The floor is CLI boot + one Sonnet round
  trip, measured ~4–5 s with the HUD showing "Thinking…". If that grates,
  the fallback is the direct
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
- **Global hotkey collisions:** `⌘.` shadows the "stop" shortcut of Xcode,
  Safari, and some terminals while Chewo runs —
  configurable from day one, and registration failure surfaces a toast.
- **HUD window focus stealing:** the HUD must never take focus from the
  frontmost app (`focusable: false`, `alwaysOnTop`) or dictating over other
  apps breaks their state.
- **`claude -p` JSON stability:** same internal-schema risk as KNOWN-ISSUES
  #1 — isolate parsing in one adapter module next to the notes-chat parser.
- **Drag-to-run shell quoting (T5):** card text reaches `zsh -il -c` as
  argv; `shellQuote` must be airtight or card content executes as shell.
  Unit tests are non-negotiable, and the T5 verification includes a
  hostile-title check (§13).
- **Auto-submit executes unreviewed content (T5):** cards now arrive from
  three sources — typing, voice (STT mishears land verbatim), and, since
  T3, **MCP-writing agents**. Drag-to-run turns card text into an executed
  prompt with no review step. Acceptable while every source is
  Martin-initiated and the session still runs under the normal permission
  mode; revisit if cards ever arrive from outside (shared boards, webhooks)
  — the prompt-injection posture of SPEC.md/KNOWN-ISSUES applies then.
- **Fresh-terminal → sessionId binding (T5):** the claude `sessionId`
  doesn't exist at spawn time and Chewo has no binding for fresh spawns, so
  the card↔session link is ephemeral renderer state. If a persistent
  "reopen the session this card ran in" is ever wanted, that binding is the
  prerequisite.
- **`--add-dir` behavior:** verify on the current CLI that it grants image
  reads without a prompt; flag semantics may drift across CLI updates.
- Open: everything in §2.

---

## 13. Verification (end of each phase)

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
- **T4:** move two cards to Done, hit "Archive done" — Done empties, the
  header shows "Archived 2". Open the drawer, restore one with an image —
  it lands at the top of Todo with the image still attached. Delete the
  other from the drawer (two clicks) and confirm its PNG is gone from
  `assets/`. Type in the filter — columns narrow, counts read `n/total`,
  Esc clears. Add a card while filtered and confirm the filter drops so the
  new card is visible. Remove a project with the box unchecked and confirm
  `~/.chewo/todos/p-…/` survives; remove another with it checked and confirm
  the folder is gone.
- **T5:** drag a card with title+text+image on a project board — strip
  appears only during drag; drop → card lands at top of In Progress, code
  workflow focuses a new tab in the project cwd, claude is already working
  on the prompt with title/text verbatim and the image read without a
  permission prompt. Drop a General card → session cwd is `~`. Create a
  card titled `test '$(touch /tmp/pwned)' \`id\`` and drop it — the string
  arrives verbatim in the prompt and nothing executes in the shell. ▶ badge
  jumps to the tab; re-drop spawns a second session; drops outside
  strip/columns remain no-ops.
