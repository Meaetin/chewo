# Known Issues, Trade-offs & Deferred Work

Everything flagged during development that is *not* fixed code — open risks,
deliberate trade-offs, maintenance rituals, and deferred phases. Reference
before changing architecture or debugging weirdness.

Last updated: 2026-07-17

---

## Open risks (could bite, no fix shipped)

### 1. Schema drift — WILL happen, contained but not preventable
Both session stores are undocumented internal formats (`version` /
`cli_version` fields exist because they change). A CLI update can break the
adapter at any time. All parsing lives in `src/shared/adapter/` (one fix
point); unknown line types are counted, never fatal.
**Ritual: run `npm run canary` after every `claude` / `codex` update.** It
already caught 5 unknown record types on first run (incl. `custom-title`).

### 2. Concurrent edits in one cwd (mitigated 2026-07-17, opt-in only)
Two agents editing the same project directory will clobber each other.
Phase 4 ships an OPT-IN fix: "isolated terminal" spawns the agent in its own
git worktree + branch (see #16 for the costs). Plain terminals in the same
cwd remain unprotected — that is Martin's default mode by choice (he runs
multiple agents in one repo and monitors them himself; a concurrency badge
was considered and rejected as useless).

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

### 14. ~~Unscoped terminals are not persisted~~ RESOLVED 2026-07-17
Home is now a full section: its terminals persist in `homeTerminals`
(projects.json) and wake as dormant tabs in $HOME. Also: live tabs are no
longer scoped away on project switch — all live terminals stay visible with
section labels; only dormant tabs remain per-section.

### 15. Adapter caps
Tool results capped at 4,000 chars at parse time; digest 8k; full-transcript
pagination 8k/page. Raise consciously — these protect model context windows
and the renderer.

### 16. Worktree isolation — accepted negatives (Phase 4, 2026-07-17)
Isolated terminals trade fuss for safety. Known costs, all deliberate:

- **Gitignored files don't come along.** A fresh worktree has no `.env`,
  `.env.local`, or `node_modules`. Fix is the per-project *worktree setup
  command* (runs visibly in the pane before the agent launches). It is
  manual on purpose — auto-copying gitignored files risks leaking secrets
  into a directory the user forgot exists.
- **`npm install` per worktree is slow on big repos.** Chewo cannot paper
  over this; the real fix is project-level (pnpm's shared store makes
  worktree installs near-instant).
- **No dev servers in worktrees — by design.** Worktrees are for headless
  agent work (edit, typecheck, unit tests). Anything you want to *see
  running* merges back into the main checkout, where servers + HMR already
  live. No port offsetting will be built unless a real side-by-side-compare
  need appears.
- **Merge preconditions are git's, surfaced verbatim.** Worktree must be
  committed (dirty → merge blocked, nudge the agent to commit). A dirty
  main checkout with overlapping files makes git refuse — Chewo shows the
  message, never auto-stashes. Conflicts abort the merge cleanly
  (`merge --abort`) and resolution happens in the main checkout, by the
  user or an agent — never by Chewo.
- **Removal can be refused.** `git worktree remove` refuses if the worktree
  has modified/untracked (non-ignored) files. Chewo surfaces the error;
  force-removal is a manual decision (`git worktree remove --force`).
- **Orphans are possible.** Worktrees live under `~/.chewo/worktrees/
  <repo-basename>/<task>`. Deleting a project from Chewo (or the repo
  itself) leaves worktrees + `agent/*` branches behind. Cleanup:
  `git worktree prune` + delete the folder/branches.
- **Task-name collisions.** Branch `agent/<task>` or the worktree folder
  already existing → creation fails with the git error. Also: two different
  repos with the same basename share a parent folder — same task name in
  both collides. Rename the task; no auto-suffixing.
- **Sessions outlive their worktree.** After removal, the transcript stays
  (session store is read-only) but resuming it spawns in `$HOME` (cwd gone
  → fallback) — the agent will be confused about where its files went.
  Dormant tabs bound to a removed worktree are cleaned up; sidebar history
  rows are not.
- **Setup command is trusted input.** It's chained with `&&` before the
  agent command and runs with the user's shell. It is per-project,
  user-authored config — Chewo never generates or edits it on its own.

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
- **electron-vite dev needs `--watch`** (now in the dev script): without it,
  only renderer code hot-reloads — main/preload edits silently never reach
  the running app. Symptom: UI renders new features but preload-backed data
  (`window.api.*`) is undefined. Cost us the "Home shows 0 sessions" bug.

---

## Deferred phases (from SPEC.md)

- **Phase 3 remainder — inbox nudge**: app watches
  `~/.context-bridge/inbox/`, types a visible "check your inbox" into the
  target pane for the user to submit. Handoff currently works pull-only.
- ~~**Phase 4 — worktree isolation**~~ BUILT 2026-07-17 (opt-in isolated
  terminals; see #16 for accepted negatives).
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
