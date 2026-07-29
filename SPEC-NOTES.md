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
them transcribed, broken down by an LLM into structured, sectioned
notes filed under subjects/topics, and then **query the whole corpus with
agents** ("summarize what I've covered on X", "answer this from my notes").

**Goal:** a Notes workflow, switched from the top-left of the app, with:
- live mic dictation → streaming raw transcript → on-stop LLM structuring
- pasted text and typed notes in the same store
- manual Subject → Topic filing, notes as markdown on disk
- an inline chat panel that answers questions across notes via a headless agent

**Non-goals (v1):**
- image paste (future phases).
- Todo workflow (separate spec later; the switcher must accommodate it).

---

## 2. Locked decisions (Q&A 2026-07-17)

| Question | Decision | Rejected |
|---|---|---|
| STT engine | **Deepgram streaming API**, with a local sidecar for capture only (revised 2026-07-29) | Local WhisperKit (was v1 — removed), whisper.cpp in-process |
| v1 inputs | Live mic, paste text, typed notes | Audio-file import, images (deferred) |
| Storage | **Markdown files + folders** on disk | projects.json blob, SQLite |
| Intelligence | **A headless agent CLI, user-selectable** (Settings → Agents): `claude -p` or `codex exec`. Registry + flag/envelope adapter in `src/shared/agents.ts` + `src/main/agent-runner.ts`; default Claude | Hardcoding one CLI (was the case until 2026-07-29), direct Anthropic API, Ollama |
| Structuring trigger | **On stop** — one pass over the full transcript | Live incremental, manual-only |
| Q&A surface | **Inline chat panel** in notes mode | Terminal pane, both-at-once |
| Taxonomy | **Fully manual** — user names subject and topic | AI-suggested, fully automatic |
| Raw retention | **Keep transcript; audio only until the transcript lands** (§6.4) | Keep audio indefinitely, keep nothing |

**Revised 2026-07-29 — transcription moved off this machine.** v1 ran
WhisperKit locally. Provisioning it was the whole problem: a 1.5 GB download, a
cache location the app had to take ownership of, completion markers because an
interrupted download looks complete and fails hours later at load, and a
17 s–2 min model load. Deepgram removes all of it — no weights, no catalog, no
residency, ~300 ms to first word. What it cannot do is capture audio, so the
Swift sidecar survives for exactly that (§6.2).

The costs are real and are accepted: **dictation now needs a network
connection**, and **audio leaves the machine** — including, for `mix`/`system`
capture, the voices of everyone else in the meeting. Nothing in the UI, specs,
README, or the two TCC permission strings may describe transcription as local.
Pricing is per minute of audio (§6.3), so a long lecture has a cost attached
where it previously had none.

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
   chewo-audio-capture     reads .raw.md,          cwd = scope dir,
   (Swift, capture only)   stdout → note.md        tools: Read/Grep/Glob
   PCM on fd 3 → Deepgram
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
stt: { model: nova-3-general, language: en }          # dictation only
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

## 6. Dictation

Two processes. A headless Swift sidecar owns audio capture and nothing else;
the Electron main process owns the Deepgram connection, the API key, and every
decision about what the words mean.

```
Swift sidecar                     Electron main                     renderer
─────────────                     ─────────────                     ────────
mic / process tap ──16k mono──▶  fd 3 ──▶ Deepgram WS ──Results──▶  partial/final
     level meter ──stdout JSON──▶         └─▶ userData/recordings/<id>.pcm
```

The split exists because nothing in Electron can open a Core Audio process tap
(`mix`/`system`), while everything about the provider is easier to change in
TypeScript than in a Swift rebuild. The key never enters the renderer.

### 6.1 Protocol

Control is **JSON-lines over stdio**; audio is **raw PCM on fd 3**, so a burst
of samples can never be mistaken for an event.

stdin (commands):
```json
{"cmd":"start","source":"mic"}
{"cmd":"stop"}
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
{"event":"ready"}
{"event":"level","rms":0.31}     // ~5 Hz, for the meter
{"event":"stopped"}
{"event":"error","message":"…"}
```

fd 3: 16 kHz mono interleaved **Int16** (Deepgram `linear16`) in ~50 ms frames,
from `ready` until `stopped`.

**`stopped` means the audio is complete.** The sidecar drains its write queue
before emitting it, so a reader that has consumed fd 3 to that point has the
whole recording — which is what lets main close the Deepgram stream without
clipping the final words.

Events the *renderer* sees are a separate, smaller union
(`connecting | ready | level | partial | final | error`): main synthesises
`connecting` around the Deepgram handshake and `partial`/`final` from Deepgram
messages. The sidecar knows nothing about any of them.

### 6.2 Capture sidecar: `chewo-audio-capture`

Swift CLI in `packages/audio-capture/` (SwiftPM), built by a script in dev,
bundled binary in the packaged app. **No package dependencies** — it is Core
Audio and AVFoundation only, so a clean build is seconds.

- `MicCapture` is `AVAudioEngine` + `installTap`, with one `AVAudioConverter`
  to 16 kHz mono Int16 (which also does the channel downmix, so a stereo
  interface needs no special case).
- `DeviceMixCapture` is the process tap: private aggregate device, drift
  compensation, mono mixdown, one stateful converter across the session.
- Frames are written on a **dedicated queue, never the audio thread** — a
  Core Audio IOProc is a realtime context and a `write` into a full pipe
  blocks, which would surface as dropouts rather than as backpressure.
- Microphone permission goes through `AVCaptureDevice.requestAccess(for:.audio)`.
  `AVAudioApplication` is iOS-only; asking explicitly means a denial is a clean
  error event rather than a capture that silently records digital black.

### 6.3 Transcription: Deepgram streaming

`src/main/deepgram.ts` is the only file that talks to Deepgram, over
`listen.v1` (`@deepgram/sdk` v5). Params are `encoding=linear16`,
`sample_rate=16000`, `channels=1`, `interim_results`, `smart_format`, and
`endpointing` / `utterance_end_ms` set **explicitly** because the API reference
and the SDK examples disagree about the defaults.

- **Booleans on the WebSocket go as strings** (`interim_results: 'true'`).
  Real booleans are silently dropped. The pre-recorded endpoint takes real
  booleans — the asymmetry is a live trap.
- Mapping lives in a pure `TranscriptAssembler`: interim messages replace the
  `tail`, `is_final` messages append to `confirmed`. Paragraphs exist only in
  `confirmed` (append-only, so breaks never move) and use the rule ported from
  the Whisper engine — a gap over 1.75 s, or 4 sentences at a boundary.
- `KeepAlive` every 4 s of silence (Deepgram drops idle connections at 10 s);
  `CloseStream` on stop, then wait for the flush `Results` + `Metadata`.
- **Model choice is two tiers, not the catalog.** Deepgram lists 41 streaming
  models across ~400 rows, nearly all domain variants or superseded
  generations; Settings → Voice offers Nova-3 monolingual ($0.0048/min) and
  Nova-3 multilingual ($0.0058/min). Multilingual is not a separate model — it
  is the same `nova-3-general` with `language=multi`, billed differently.
  The catalog is still fetched (cached per session) to fill the language list,
  which does grow over time.
- **`nova-3` is a wire alias Deepgram accepts but never lists.** Storing it
  leaves a picker built from the catalog with no matching row, which is how the
  model setting silently drifted once. `normalizeStt` migrates the known
  aliases to their canonical names.
- Flux is **not** offered: it is served over `listen.v2` with a different
  message protocol.

### 6.4 Safety net: recordings and recovery

Every capture is written to `userData/recordings/<id>.pcm` at the same time it
goes onto the wire, with a `.json` twin naming the lesson, style, model and
language. The failure this guards is a two-hour lecture and a dropped
connection forty minutes in: the stream is gone, the audio is not.

- Writes are **synchronous** (`writeSync`, not a stream). A buffered stream
  loses whatever is in the buffer when the app dies, and dying mid-recording is
  precisely the case this exists for. ~1600 bytes at ~20/sec — microseconds.
- A clean `final` deletes both files. Anything else leaves them, and they
  appear in Settings → Voice as a pending recovery.
- Recovery wraps 5-minute slices in a WAV header and submits them to the
  pre-recorded API in sequence, joining the results, then appends through the
  same structuring path a live dictation uses. The chunking exists because the
  batch endpoint 504s past ~10 minutes of audio.
- ~1.9 MB/min, so a two-hour lecture is ~230 MB — which is why the clean path
  deletes immediately.

## 7. Structuring pass (on stop)

1. On `final`, main writes `<note>.raw.md` (frontmatter `status: raw`).
2. Main runs the agent chosen for `notesStructure` with env scrubbed exactly like `buildPtyEnv` (shown here as Claude; `agent-runner` swaps the flags per agent):

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
  titles/filenames (content grep later). Right-clicking a subject or topic
  opens a context menu: **Rename** (inline input on the row) and **Move to
  Trash** (confirmed when the folder is non-empty) — same two actions on a
  focused row via `⏎` and `⌘⌫`/`⌦`, matching the file tree. Styling stays in
  `styles.css` (BEM-ish classes, e.g. `.notes-tree`, `.note-row`),
  dark-theme variables.
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
  write, createFolder, rename, delete), `stt:*` (start/stop + event stream),
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
  `packages/chewo-mcp/src/server.ts` so **coding agents** can also read
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
- **N2 — Dictation:** `chewo-audio-capture` sidecar; sidecar lifecycle +
  Deepgram stream in main + `stt:*` IPC; recording view with live transcript;
  on-stop structuring pass; re-structure action. *(Shipped as a local
  WhisperKit engine, replaced by Deepgram 2026-07-29 — see §2 and §6.)*
- **N3 — Q&A:** inline chat panel, scope selector, `claude -p` stream-json
  runner in main, `--resume` multi-turn, coding-sidebar cwd filter.
- **N4 — Later:** audio-file import; image paste; notes tools in the MCP
  server; (todo workflow gets its own spec). *(A second local engine —
  Parakeet A/B — is dropped: transcription is no longer local.)*

---

## 11. Risks & open questions

- **Mic permission (TCC):** the sidecar inherits Chewo's identity; dev runs
  prompt as Electron, the packaged app needs `NSMicrophoneUsageDescription` +
  the audio-input entitlement. Verify early in N2.
- **Sidecar distribution:** with WhisperKit dropped the sidecar is Core Audio
  only — a ~200 KB binary with no package dependencies, and no weights to ship
  or download at all. `~/.chewo/models` from the WhisperKit era is left on disk
  and reclaimable from Settings → Voice.
- **Network dependency (new 2026-07-29):** dictation now fails without a
  connection, where the local engine only needed a first download. A dropped
  mid-lecture connection is covered by the on-disk recording and recovery
  (§6.4); a lecture started with no connection at all simply cannot record.
- **Cost:** ~$0.29/hour monolingual, ~$0.35/hour multilingual. A two-hour
  lecture is ~$0.58 — small, but non-zero where it used to be free, and the
  meter runs whenever the mic is open.
- **Third-party audio:** `mix`/`system` capture sends everyone else on the call
  to Deepgram, not just the user. The permission strings and the Voice pane say
  so; whether that needs a per-recording consent step is open.
- **`claude -p` latency:** seconds of cold start per structuring/Q&A call —
  acceptable on-stop; revisit if inline chat feels sluggish.
- **`claude -p` output stability:** `--output-format json` / `stream-json`
  schemas are the same internal-schema risk as session JSONL (KNOWN-ISSUES
  #1) — isolate parsing in one adapter module.
- **Accent accuracy:** if Nova-3 misses words on accented speech, the levers
  are keyterm prompting (already exposed in Settings → Voice) and, failing
  that, Deepgram's newer Flux model — which needs a `listen.v2` client, a
  different message protocol, and is therefore real work rather than a setting.
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
