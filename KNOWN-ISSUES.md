# Known Issues, Trade-offs & Deferred Work

Everything flagged during development that is *not* fixed code — open risks,
deliberate trade-offs, maintenance rituals, and deferred phases. Reference
before changing architecture or debugging weirdness.

Last updated: 2026-07-16

---

## Open risks (could bite, no fix shipped)

### 1. Schema drift — WILL happen, contained but not preventable
Both session stores are undocumented internal formats (`version` /
`cli_version` fields exist because they change). A CLI update can break the
adapter at any time. All parsing lives in `src/shared/adapter/` (one fix
point); unknown line types are counted, never fatal.
**Ritual: run `npm run canary` after every `claude` / `codex` update.** It
already caught 5 unknown record types on first run (incl. `custom-title`).

### 2. Concurrent edits in one cwd (Phase 4 not built)
Two agents (Claude + Codex panes) editing the same project directory will
clobber each other. No protection exists. Planned fix: git-worktree-per-pane
isolation option. Until then: don't run both agents on the same repo with
auto-approve on.

### 3. Prompt-injection exfiltration via the bridge
The bridge exposes ALL session history to any session that can call its
tools. A malicious instruction in an untrusted repo (README, code comments)
could ask a permissions-auto-approved agent to read other sessions and leak
them. Mitigations shipped: read-only tools, audit log
(`~/.context-bridge/audit.log`). Not shipped: per-project allowlist/denylist.

### 4. cwd-boost assumption UNVERIFIED
Bridge search boosts sessions from the CLI's cwd, assuming both CLIs spawn
MCP servers in the session's working directory. Never confirmed.
**Check: `grep startup ~/.context-bridge/audit.log`** — if cwd is `/` or the
app dir instead of project dirs, the boost silently degrades to neutral
(safe failure) and the project path must be routed in differently.

### 5. Codex env vars not scrubbed from ptys
We scrub `CLAUDECODE` / `CLAUDE_*` from spawned pty envs (a nested claude
that inherits `CLAUDE_CODE_SESSION_ID` silently NEVER persists its session —
that bug cost a real conversation). Codex likely has analogous `CODEX_*`
nesting markers; not scrubbed because no repro yet. If Codex panes ever show
missing/weird session files, this is the first suspect
(`src/main/terminals.ts` → `buildPtyEnv`).

### 6. Noise filter false positives (accepted trade-off)
Any user message starting with a pseudo-XML tag (`<div>…`) or `# AGENTS.md`
is classified as machine noise and dropped from transcripts/previews/titles.
Rare but possible legit-message loss. If a message is mysteriously missing
from a transcript, check `src/shared/adapter/noise.ts` first.

### 7. Session-binding heuristic edge cases
Fresh panes bind to session files by source + cwd + created-after-spawn
(10s clock slop), oldest pane first. Known gaps: two fresh panes in one cwd
bind in spawn order (can mismatch); label stays "(new)" until the CLI writes
its first session file (usually after first message) + 1s watcher debounce.

---

## Deliberate design decisions (revisit consciously, not accidentally)

### 8. Hide, never delete
"Remove session" hides app-wide (projects + search) via
`hiddenSessionIds` in projects.json. Files on disk are NEVER touched — the
CLI stores are read-only per spec (deleting would break `claude --resume`
pickers and Codex history). True deletion exists only via `codex delete
<id>` (no Claude Code equivalent). **The bridge does NOT read the hidden
list** — models can still find hidden sessions. Hiding = UI decluttering,
not memory erasure.

### 9. Disk is the only data source
Everything (sidebar, bridge) reads session JSONL from disk. Anything a CLI
doesn't persist is invisible (the nested-session bug proved this). Mid-
generation partial output has sub-second staleness. Real-time structured
events require the Phase 5 app-server/SDK path — deferred until a concrete
need (custom approval UI or live agent-to-agent loops).

### 10. Full reparse on every scan (no cache)
`scanAll()` parses every session file on each bridge tool call and each
watcher rescan; `get_session` scans twice (id lookup + load). Measured fine
at ~230 sessions (<1s). Fix when felt, not before: mtime-keyed in-process
cache + persistent id→filePath map (design in git history / conversation).
Trigger: noticeable latency, or ~1–2k sessions.

### 11. Digest quality is the cheap v1
Bridge `get_session` summary = title + user messages + final assistant
reply + files touched, hard-capped 8k chars. If cross-model references feel
shallow in practice, upgrading summarization (LLM pass inside the bridge)
is THE lever — before adding any new tools.

### 12. User messages render literal, assistant renders markdown
Deliberate: users paste code/logs that markdown would mangle.

### 13. Search-visibility model
Projects scope by path prefix (longest match wins). Sessions with no
recoverable cwd appear ONLY via global search. Sidebar search is global on
purpose — the escape hatch after removing "All sessions". ⌘F transcript
find only searches rendered DOM: collapsed tool outputs are excluded until
expanded.

### 14. Unscoped terminals are not persisted
Dormant-tab persistence is per-project. Terminals opened with no project
selected (spawn in $HOME) die with the app and are not remembered. Add a
top-level saved-terminals list if this ever hurts.

### 15. Adapter caps
Tool results capped at 4,000 chars at parse time; digest 8k; full-transcript
pagination 8k/page. Raise consciously — these protect model context windows
and the renderer.

---

## Maintenance rituals

- **After CLI updates:** `npm run canary` (drift check).
- **After editing bridge code:** `npm run build -w @cohesion/context-bridge`
  — CLIs spawn the bundled `dist/index.cjs`; running sessions keep the old
  process, new sessions pick up the new build.
- **If the repo moves:** re-register the bridge (absolute paths):
  `claude mcp add --scope user context-bridge -- node <path>/dist/index.cjs --agent claude`
  `codex mcp add context-bridge -- node <path>/dist/index.cjs --agent codex`
- **Dev mode:** editing `src/main/**` hot-restarts Electron and KILLS open
  panes. Renderer edits hot-reload harmlessly.

---

## Environment/tooling quirks (fixed, but will recur on reinstalls)

- **node-pty spawn-helper exec bit**: npm strips it on install →
  `posix_spawnp failed`. Handled by postinstall
  (`chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`). If terminals
  break after a clean install, check this first.
- **Vite pinned to ^7**: electron-vite 5 does not support Vite 8
  (`@vitejs/plugin-react` pinned to ^5 to match).
- **ESM preload**: built as `index.mjs`, requires `sandbox: false` — a wrong
  path here = silent blank window (no error anywhere; cost us a debugging
  round).
- **Electron binary**: if `npm run dev` says "Electron uninstall", run
  `node node_modules/electron/install.js` (interrupted download).

---

## Deferred phases (from SPEC.md)

- **Phase 3 remainder — inbox nudge**: app watches
  `~/.context-bridge/inbox/`, types a visible "check your inbox" into the
  target pane for the user to submit. Handoff currently works pull-only.
- **Phase 4 — worktree isolation**: fixes risk #2.
- **Phase 5 — app-server/SDK rendering**: custom chat UI over
  `claude --print --output-format stream-json` / Agent SDK and
  `codex app-server`. Triggers: needing custom approval flows or real-time
  structured events. Cost: reimplementing approvals, interrupts, slash
  commands — ×2 protocols.

### Product-level flag
Official Claude Code desktop/web apps already browse session history. This
app's differentiation is CROSS-MODEL cohesion (unified sidebar + bridge +
handoffs) — single-tool history browsing alone is not a product.

### Missing hardening (small, known)
- No renderer error boundary — a throw in React = blank window (the preload
  bug would have been loud instead of silent with one).
- `safeSend` exists for main→renderer races (frame disposal during reload);
  any NEW `webContents.send` call site must use it.
