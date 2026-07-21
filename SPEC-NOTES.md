# Chewo Notes — SPEC-NOTES.md

**Feature:** Note-taking workflow (second top-level workflow beside coding)
**Platform:** macOS desktop app (Electron) — extends Chewo
**Author:** Martin
**Date:** 2026-07-17
**Status:** Draft v1 — decisions locked via Q&A, not yet implemented

---

## 1. Problem & Goal

Lessons (lectures, meetings, study sessions) arrive as speech or pasted text and
die as unstructured transcripts. Martin wants to capture them in Chewo, have
them transcribed locally, broken down by an LLM into structured, sectioned
notes filed under subjects/topics, and then **query the whole corpus with
agents** ("summarize what I've covered on X", "answer this from my notes").

**Goal:** a Notes workflow, switched from the top-left of the app, with:
- live mic dictation → streaming raw transcript → on-stop LLM structuring
- pasted text and typed notes in the same store
- manual Subject → Topic filing, notes as markdown on disk
- an inline chat panel that answers questions across notes via headless Claude

**Non-goals (v1):**
- image paste (future phases).
- Todo workflow (separate spec later; the switcher must accommodate it).

---

## 2. Locked decisions (Q&A 2026-07-17)

| Question | Decision | Rejected |
|---|---|---|
| STT engine | **Local sidecar process**, pluggable engines | whisper.cpp in-process, cloud API |
| v1 inputs | Live mic, paste text, typed notes | Audio-file import, images (deferred) |
| Storage | **Markdown files + folders** on disk | projects.json blob, SQLite |
| Intelligence | **Headless Claude Code** (`claude -p`) | Direct Anthropic API, Ollama |
| Structuring trigger | **On stop** — one pass over the full transcript | Live incremental, manual-only |
| Q&A surface | **Inline chat panel** in notes mode | Terminal pane, both-at-once |
| Taxonomy | **Fully manual** — user names subject and topic | AI-suggested, fully automatic |
| Raw retention | **Keep transcript, discard audio** | Keep audio, keep nothing |

Context on STT accuracy: the existing dictation prototype
(`~/Desktop/Projects/untitled-project`) uses **WhisperKit** (local Core ML
Whisper, not the OpenAI API) with `openai_whisper-base.en` — the ~90% accuracy
on accented speech is almost certainly the tiny model, not Whisper itself.
Default here is **`large-v3-turbo`**; Parakeet (`parakeet-mlx`) is a phase-4
A/B alternative, which is why the sidecar protocol is engine-agnostic.

---

## 3. Architecture overview

```
┌───────────────────────────────────────────────────────────────────┐
│ Electron app                                                       │
│  ┌──────────────┐  ┌───────────────────────────────────────────┐  │
│  │ Sidebar      │  │ Main panel (workflow: 'code' | 'notes')    │  │
│  │ [Code|Notes] │  │  code:  terminals / transcript / caps      │  │
│  │  switcher    │  │  notes: editor / recording / empty  + chat │  │
│  └──────────────┘  └───────────────────────────────────────────┘  │
│         main process                                               │
│  ┌────────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ STT sidecar    │   │ structuring pass │   │ notes chat      │  │
│  │ spawn + stdio  │   │ claude -p (json) │   │ claude -p       │  │
│  └───────┬────────┘   └────────┬─────────┘   │ (stream-json)   │  │
│          │                     │             └────────┬────────┘  │
└──────────┼─────────────────────┼──────────────────────┼───────────┘
   chewo-stt-whisper       reads .raw.md,          cwd = scope dir,
   (Swift/WhisperKit CLI)  stdout → note.md        tools: Read/Grep/Glob
   later: chewo-stt-parakeet
                     <notes root>/<Subject>/<Topic>/*.md
                     (chokidar-watched, disk is the only data source)
```

Everything follows existing Chewo patterns: renderer owns state, main persists
a JSON blob, disk stores are watched with chokidar and fully reparsed, agent
work runs as spawned CLI processes with scrubbed env (`buildPtyEnv` pattern in
`src/main/terminals.ts`).

---

## 4. Workflow switcher (top-left)

- A segmented control at the very top of the sidebar, above `sidebar-actions`
  (`src/renderer/src/components/Sidebar.tsx`): **`Code | Notes`**, built to
  take a third segment (Todo) later.
- App-level state in `App.tsx`: `workflow: 'code' | 'notes'`, persisted.
- Switching **hides, never unmounts,** the coding UI — same trick as
  `TerminalPane`'s `active` prop — so terminals and live sessions keep running.
- Sidebar content swaps per workflow: sessions/projects (code) vs the
  subject/topic tree (notes). `main-panel` swaps likewise.
- Notes main-panel state is a second discriminated union next to `MainView`
  (`App.tsx:33`):

```ts
type NotesView =
  | { kind: 'note'; path: string }        // editor
  | { kind: 'recording'; draft: DraftMeta }
  | { kind: 'empty' }
```

---

## 5. Notes store

```
~/Documents/Chewo Notes/               # default root (legacy installs keep ~/ChewoNotes); configurable in settings
  Anatomy/                             # subject = folder (user-created)
    Upper Limb/                        # topic = subfolder (user-created)
      2026-07-17-brachial-plexus.md      # structured note
      2026-07-17-brachial-plexus.raw.md  # raw transcript (kept forever)
```

- **Frontmatter** on every note:

```yaml
---
title: Brachial plexus
date: 2026-07-17T14:05:00+08:00
source: dictation        # dictation | paste | typed
status: structured        # raw | structured
stt: { engine: whisperkit, model: large-v3-turbo }   # dictation only
duration_s: 2710                                      # dictation only
---
```

- Manual taxonomy: subject + topic are **required before capture starts**
  (picker in the recording/new-note views). Creating/renaming = folder ops.
- Typed and pasted notes are ordinary `.md` files in the same tree; pasted
  text gets a `.raw.md` twin only if the structuring pass is run on it.
- Main watches the notes root with chokidar → `notes:changed` push, full
  rescan, no cache — mirrors `watchSessionStores` (`src/main/index.ts:150`).
- Filenames: `YYYY-MM-DD-<kebab-title>.md`; collisions get `-2`, `-3`.

---

## 6. STT sidecar

A headless local process owning mic capture + streaming transcription,
spawned by main via `child_process.spawn` (not node-pty), speaking
**JSON-lines over stdio**.

### 6.1 Protocol

stdin (commands):
```json
{"cmd":"start","model":"large-v3-turbo","source":"mic"}
{"cmd":"stop"}            // flush tail, emit final, stay alive
{"cmd":"shutdown"}
```

`source` picks the capture: `"mic"` (default, dictation), `"mix"` — device
output + mic summed into one stream — or `"system"` — device output only.
mix/system run through a Core Audio process tap + private aggregate device
with drift compensation (macOS 14.2+; one-time System Audio Recording TCC
permission, usage string embedded in the CLI's `__info_plist` section);
`system` skips the mic entirely, including its permission prompt. The UI
pairs source with an independent lecture/meeting choice that only affects
the structuring prompt, not capture.

stdout (events):
```json
{"event":"loading","progress":0.42}      // first-run model download / prewarm
{"event":"ready"}
{"event":"level","rms":0.31}             // ~5 Hz, for the meter
{"event":"partial","confirmed":"…","tail":"…"}   // ~750 ms cadence
{"event":"final","text":"…","duration_s":2710}
{"event":"error","message":"…"}
```

### 6.2 Engine 1 (v1): `chewo-stt-whisper`

Swift CLI extracted from the untitled-project prototype — port
`WhisperDictationService.swift` verbatim (WhisperKit load, `AudioProcessor`
live capture at 16 kHz, and the **confirm-and-seek** loop: decode only the
unconfirmed tail via `clipTimestamps`, promote all but the trailing 2 segments,
750 ms polling gated on ~0.75 s of new samples). Strip SwiftUI; replace
`DictationViewModel`'s loops with the stdio protocol. Lives in
`packages/stt-whisper/` (SwiftPM), built by a script in dev, bundled binary in
the packaged app.

- Default model `large-v3-turbo`, selectable in notes settings
  (tiny → large-v3). WhisperKit downloads models on first use — surface via
  `loading` events with a progress bar in the recording view.

### 6.3 Engine 2 (phase 4): `chewo-stt-parakeet`

`parakeet-mlx` wrapped in a Python CLI speaking the identical protocol.
Settings gets an engine dropdown; A/B on the same lesson = record with one,
re-run later (transcripts are kept, audio is not, so A/B means dictating twice
or temporarily keeping audio during the trial — acceptable).

---

## 7. Structuring pass (on stop)

1. On `final`, main writes `<note>.raw.md` (frontmatter `status: raw`).
2. Main runs headless Claude with env scrubbed exactly like `buildPtyEnv`:

```
claude -p --output-format json --allowedTools "Read" \
  "Read <abs path to .raw.md>. Produce a structured markdown study note: \
   ## sections by theme in lecture order, bullet key points, **bold** terms \
   with definitions, a final ## Summary. Be faithful to the transcript; \
   never invent content; keep the speaker's examples. Output only markdown."
```

3. Main writes the result as the structured note (frontmatter
   `status: structured`), keeps the `.raw.md` twin, opens the note in the
   editor. Failure → toast + note stays raw with a "Structure" retry button.
4. A "Re-structure" action on any note re-runs the pass from its `.raw.md`.
5. A 1 h lecture ≈ 10k words ≈ well within one Claude pass — no chunking in v1.
6. Same pass powers "Structure" on pasted text.

---

## 8. Notes UI

- **Sidebar (notes mode):** `+ Subject`, `+ Topic` buttons; tree
  Subject → Topic → notes (dated, newest first); search box filtering
  titles/filenames (content grep later). Styling stays in `styles.css`
  (BEM-ish classes, e.g. `.notes-tree`, `.note-row`), dark-theme variables.
- **Recording view:** subject/topic picker (required), model/engine indicator,
  record button, elapsed time, level meter, live transcript — confirmed text
  solid, unconfirmed tail dimmed (maps 1:1 onto confirm-and-seek). Stop →
  inline "Structuring…" spinner → opens the structured note.
- **Editor:** CodeMirror 6 (markdown mode) with an edit/preview toggle
  (preview rendered with `marked`). Autosave on debounce; writes go through a
  `notes:write` IPC handler in main.
- **New from text:** paste box → subject/topic picker → save as-is (typed) or
  "Structure" (runs §7).
- **IPC surface added to `src/preload/index.ts`:** `notes:*` (scan, read,
  write, createFolder, delete), `stt:*` (start/stop + event stream),
  `notesChat:*` (send + stream events), `onNotesChanged`.
- **Settings:** notes root path, STT engine + model — persisted in the
  `ProjectsFile` blob (`src/shared/projects.ts:67`) as a `notesSettings` field,
  alongside `workflow`.

---

## 9. Q&A chat panel

- Collapsible right-hand pane inside the notes workflow with a **scope
  selector**: All notes / a subject / a topic.
- Backed by `claude -p --output-format stream-json --allowedTools
  "Read,Grep,Glob"` with **`cwd` set to the scope's directory** — scoping is
  free via the filesystem; no MCP server needed in v1. Streamed into chat
  bubbles; multi-turn via `--resume <session-id>`.
- Phase 4: add `search_notes` / `get_note` / `list_subjects` tools to
  `packages/context-bridge/src/server.ts` so **coding agents** can also read
  the notes corpus (the sanctioned extensibility point per SPEC.md §4.4).
- **Sidebar pollution guard:** these chat runs create real Claude sessions
  with `cwd` under the notes root — filter any session whose cwd is inside
  `notesRoot` out of the coding sidebar (`src/shared/projects.ts`
  section-assignment logic).

---

## 10. Build order

- **N1 — Foundation (no audio, no AI):** workflow switcher + persisted
  `workflow`; notes store + chokidar watcher + rescan; notes sidebar tree;
  CodeMirror editor + preview; typed and pasted notes; settings field.
- **N2 — Dictation:** extract `chewo-stt-whisper` sidecar from
  untitled-project; sidecar lifecycle in main + `stt:*` IPC; recording view
  with live transcript; on-stop structuring pass; re-structure action.
- **N3 — Q&A:** inline chat panel, scope selector, `claude -p` stream-json
  runner in main, `--resume` multi-turn, coding-sidebar cwd filter.
- **N4 — Later:** `chewo-stt-parakeet` + engine A/B setting; audio-file
  import; image paste; notes tools in context-bridge; (todo workflow gets its
  own spec).

---

## 11. Risks & open questions

- **Mic permission (TCC):** the sidecar inherits Chewo's identity; dev runs
  prompt as Electron, the packaged app needs `NSMicrophoneUsageDescription` +
  the audio-input entitlement. Verify early in N2.
- **Sidecar distribution (sized 2026-07-17):** the Swift sidecar binary is
  ~6 MB (measured; WhisperKit links statically) — negligible bundle impact.
  **Never bundle models:** WhisperKit downloads them lazily to
  `~/Documents/huggingface/…`, outside the .app, so they survive app updates.
  `large-v3-turbo` quantized is a ~630 MB one-time download (`base.en` 140 MB,
  full `large-v3` ~950 MB) — needs the `loading` progress UI, and a wifi-less
  first lecture fails, so offer model preload from settings. Parakeet's real
  cost is not the ~900 MB model but the Python/MLX runtime (~300–500 MB
  standalone Python) — keep it strictly phase-4, download-on-opt-in.
- **`claude -p` latency:** seconds of cold start per structuring/Q&A call —
  acceptable on-stop; revisit if inline chat feels sluggish.
- **`claude -p` output stability:** `--output-format json` / `stream-json`
  schemas are the same internal-schema risk as session JSONL (KNOWN-ISSUES
  #1) — isolate parsing in one adapter module.
- **Accent accuracy:** if `large-v3-turbo` still misses ~10% of words, that —
  not features — becomes the N4 priority (Parakeet A/B, or initial-prompt
  vocabulary hints per subject).
- Resolved: notes root defaults to `~/Documents/Chewo Notes` (legacy installs
  with an existing `~/ChewoNotes` keep it) — see docs/decisions.md 2026-07-19.
- Open: whether recording
  continues if the user switches back to the code workflow mid-lesson
  (proposed: yes, with a small "recording" pill on the switcher).

---

## 12. Verification (end of each phase)

- **N1:** run the app; switch Code↔Notes and confirm a live terminal keeps
  streaming; create subject/topic/typed note; confirm the `.md` appears on
  disk with frontmatter; edit the file externally and see the sidebar update.
- **N2:** dictate ~2 min of speech; confirm live confirmed/tail rendering,
  `final` on stop, `.raw.md` + structured `.md` written, sections faithful to
  what was said; kill the sidecar mid-recording and confirm graceful error.
- **N3:** ask a question scoped to a topic and confirm the answer cites only
  that topic's notes; follow up and confirm `--resume` context holds; confirm
  no notes-chat sessions appear in the coding sidebar.
