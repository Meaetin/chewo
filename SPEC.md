# Agent Cohesion Workbench — SPEC.md

**Working title:** Agent Cohesion Workbench (rename freely)
**Platform:** macOS desktop app (Electron)
**Author:** Martin
**Date:** 2026-07-16
**Status:** Draft v1 — validated against Claude Code 2.1.211 and codex-cli 0.142.5 installed locally

---

## 1. Problem & Goal

Claude Code and Codex CLI each keep their own session history and their own
context. Working with both means manually copy-pasting context between
terminals and losing track of which conversation holds which decision.

**Goal:** one desktop app where both CLIs run side by side, all past sessions
from both tools are browsable in a single sidebar, any session can be resumed
with a click, and — the core feature — **both models can read each other's
session history and hand context to each other** ("cohesion").

**Non-goals (v1):**
- Replacing the CLIs' own UIs. The terminals stay real terminals.
- Real-time sub-second agent-to-agent chat (see §9, app-server path).
- Windows/Linux support.

---

## 2. Verified Ground Truth (from the local machine)

### 2.1 Claude Code session storage
```
~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl
```
- One JSONL file per session; directory name encodes the project path
  (e.g. `-Users-martin-Desktop-Projects-Argo`) → grouping by project is free.
- Line types observed: `user`, `assistant`, `attachment`, `file-history-snapshot`,
  `mode`, `permission-mode`, `bridge-session`, `last-prompt`, `ai-title`.
- Messages form a **tree**: `uuid` + `parentUuid`; `isSidechain: true` marks
  subagent branches (which also get a `<sessionId>/subagents/` folder).
- `message` field holds the raw Anthropic API shape (`role`, `content[]` of
  `text` / `tool_use` / `tool_result` blocks).
- Useful metadata per line: `timestamp`, `cwd`, `gitBranch`, `version`,
  `slug` / `aiTitle` (human-readable session title).

### 2.2 Codex CLI session storage
```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
~/.codex/session_index.jsonl    # {id, thread_name, updated_at} — ready-made sidebar index
~/.codex/history.jsonl          # flat cross-session log of user inputs
```
- Rollout line types: `session_meta` (cwd, originator, cli_version, model),
  `response_item` (messages in **OpenAI Responses API** format:
  `input_text` / `output_text`, reasoning items, `function_call` /
  `function_call_output`), `event_msg` (`task_started`, `user_message`,
  `agent_message`, `token_count`, `task_complete`).

### 2.3 CLI capabilities (verified via --help)
| Capability | Claude Code 2.1.211 | codex-cli 0.142.5 |
|---|---|---|
| Resume session | `claude --resume <uuid>`, `-c` (most recent), `--session-id` | `codex resume <uuid-or-name>`, `--last`; also `fork`, `archive`, `delete` |
| Resume by name | no (UUID only) | **yes** (session name) |
| MCP client | `claude mcp add <name> -- <cmd>` | `codex mcp add`, or `[mcp_servers.*]` in `~/.codex/config.toml` |
| Run *as* server | Agent SDK; `-p --output-format stream-json --input-format stream-json` | `codex mcp-server` (stdio); `codex app-server` (experimental JSON-RPC); TUI can attach to `ws://` remote app-server |
| Headless exec | `claude -p` | `codex exec` |

### 2.4 Known risks in ground truth
- **Both JSONL schemas are internal and undocumented.** `version` /
  `cli_version` fields exist precisely because they change. All parsing must
  live in one adapter layer so breakage has one fix point.

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│ Electron app                                                  │
│  ┌────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │  Sidebar   │   │ Claude pane │   │ Codex pane  │           │
│  │  unified   │   │ xterm.js +  │   │ xterm.js +  │           │
│  │  history   │   │ node-pty    │   │ node-pty    │           │
│  └─────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│        │ watch+parse     │ spawn/resume    │ spawn/resume     │
│        │                 │                 │                  │
│  ┌─────┴─────────────────┴─────────────────┴───────┐          │
│  │ Session Adapter Layer (normalizes both formats) │          │
│  └─────┬───────────────────────────────────────────┘          │
└────────┼──────────────────────────────────────────────────────┘
         ▼
  ~/.claude/projects/**  ~/.codex/sessions/**   (read-only)
         ▲                        ▲
         │      context-bridge MCP server (stdio)
         │  spawned independently by each CLI at startup
         │  tools: search_sessions / get_session /
         │         list_recent_sessions / handoff / check_inbox
         └── shared inbox: ~/.context-bridge/inbox/<agent>/*.json
```

**Key design decision:** cross-model context is a **tool, not a pipe**.
The models fetch context themselves via MCP tool calls, mid-session, inside
ordinary interactive terminals. No TUI screen-scraping, no stdin injection as
a data channel. The filesystem is the shared memory; no daemon, no ports.

---

## 4. Component Specs

### 4.1 Session Adapter Layer (shared library)
Normalizes both on-disk formats into one model:

```ts
interface Session {
  id: string;                // CC uuid | Codex rollout uuid
  source: "claude" | "codex";
  title: string;             // CC aiTitle/slug | Codex thread_name; fallback: first user msg
  project: string | null;    // CC dir-decoded cwd | Codex session_meta.cwd
  gitBranch?: string;
  createdAt: string;
  updatedAt: string;
  filePath: string;
  messages: NormalizedMessage[];  // lazy-loaded
}

interface NormalizedMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;          // for tool_use / function_call
  filesTouched?: string[];    // extracted from tool inputs
  timestamp: string;
  isSidechain?: boolean;      // CC subagent branches — excluded from summaries by default
}
```

Rules:
- CC tree → linearize by following `parentUuid` chain to the active leaf;
  sidechains excluded unless requested.
- Codex → prefer `response_item` lines; `event_msg` only for lifecycle metadata.
- Parse failures on individual lines are skipped and counted, never fatal
  (forward compatibility with schema drift).
- Used by BOTH the Electron sidebar and the context-bridge server (one parser,
  one fix point).

### 4.2 Sidebar (Electron renderer)
- Unified list of sessions from both tools; group by project, sort by
  `updatedAt`; badge per source (Claude/Codex).
- Live updates via chokidar watching both roots.
- Search over titles + first user message.
- Click → resume in the corresponding terminal pane:
  - Claude: `claude --resume <id>` (spawned in the session's original `cwd`)
  - Codex: `codex resume <id>`
- Right-click: "Open transcript" (read-only rendered view), "Copy session id",
  "Hand off to other agent" (pre-fills a handoff, §4.4).

### 4.3 Terminal panes
- Two (or N) panes: xterm.js frontend, node-pty backend, running the real
  interactive `claude` / `codex` TUIs. All approvals/permission prompts are
  answered inline by the user — the app builds no approval UI in v1.
- Each pane records: which CLI, session id (parsed from the newest JSONL file
  created after spawn), cwd.
- Panes are dumb by design. All intelligence lives in the bridge.

### 4.4 context-bridge MCP server (the spine)
Single TypeScript program using `@modelcontextprotocol/sdk`, stdio transport.
Registered once with each CLI:

```bash
claude mcp add context-bridge -- node /path/to/bridge/dist/index.js --agent claude
codex  mcp add context-bridge -- node /path/to/bridge/dist/index.js --agent codex
```

`--agent` tells the instance who "me" is (for inbox routing). Each CLI spawns
its **own instance**; instances share state only via the filesystem.

**Tool surface (v1 — small on purpose):**

| Tool | Input | Output | Notes |
|---|---|---|---|
| `search_sessions` | `query, model?, project?, limit=5` | ranked candidate list `{id, title, source, updatedAt, preview}` | Fuzzy over titles + first-user-message. **Always returns candidates, never a single silent guess** — titles collide; let the model disambiguate. |
| `get_session` | `id, mode="summary"\|"full"\|"tail", page?` | transcript digest / paginated full text / last N turns | `summary` is default; `full` is paginated (sessions reach 1MB+). |
| `list_recent_sessions` | `model?, project?, limit=10` | same shape as search results | The model's sidebar. |
| `handoff` | `to: "claude"\|"codex", note, session_id?` | ack | Writes `~/.context-bridge/inbox/<to>/<ts>.json` with note + source-session pointer. |
| `check_inbox` | — | pending handoffs for `--agent` me, then clears them | Pull-based. |

**Summary mode (the real engineering):**
- v1 (cheap, no LLM): session title + all user messages + final assistant
  message + deduped `filesTouched` list. ~90% of useful context at ~2% of tokens.
- v2 (optional): LLM summarization pass inside the bridge for long sessions.
- Hard cap on returned tokens per call (~8k chars default, configurable).

**Handoff delivery:**
- Pull (always works): user types "check your inbox" in the target terminal.
- Push (app sugar): Electron watches the inbox dir; on new handoff it types a
  visible `check your inbox` line into the target pty **for the user to
  submit**. Injection is only ever a human-reviewed nudge, never the payload.

### 4.5 Security
- Bridge exposes the user's ENTIRE chat history to any session that can call
  its tools. Prompt-injected instructions (e.g. a malicious README in an
  untrusted repo, with permissions auto-approved) could exfiltrate other
  sessions' contents.
- v1 mitigations: bridge is read-only over history; `handoff` writes only to
  its own inbox dir; log every tool call to `~/.context-bridge/audit.log`.
- v1.5: per-project allowlist/denylist in bridge config.

---

## 5. Core User Flows

**Flow A — browse & resume:** open app → sidebar shows merged history →
click "Fix missing is_public field…" (Codex) → right pane runs
`codex resume <id>` in original cwd → conversation continues.

**Flow B — cross-reference ("refer to that chat"):** in the Codex pane, type
*"refer to the chat 'how to make an apple' and tell me more"* → model calls
`search_sessions("how to make an apple")` → gets candidates → calls
`get_session(id, "summary")` → answers with that context. Works in a plain
iTerm too; the app is not required for this flow.

**Flow C — handoff (Claude → Codex):** in Claude pane: *"hand this off to
codex: we settled on the /v2/items API schema"* → Claude calls
`handoff("codex", note, current_session_id)` → inbox file written → app
nudges Codex pane → user hits Enter → Codex `check_inbox()` →
optionally `get_session()` on the source for depth.

---

## 6. Build Order

| Phase | Deliverable | Proves |
|---|---|---|
| **1** | Session Adapter + read-only sidebar + transcript viewer + resume-on-click, terminals via pty | Data layer works; app is already useful |
| **2** | context-bridge with `search_sessions` + `get_session` + `list_recent_sessions`, registered with both CLIs | **The core bet — cohesion.** Test from a plain terminal before any app integration |
| **3** | `handoff` + `check_inbox` + inbox-watch nudge in app | Cross-agent workflow |
| **4** | Opt-in isolated terminals: git worktree + branch per agent task, merge-back flow (§10) | Safe concurrent editing |
| **5 (maybe)** | Custom chat rendering of live panes via Agent SDK / app-server (§9) | Prettier UI, approval handling — only if the terminal UX proves insufficient |

Phase 2 is deliberately buildable and testable **without** Phases 1's UI —
it's the riskiest assumption, validate it first if in doubt.

---

## 7. Risks & Open Questions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Summary quality** — bad digests make cohesion useless | High | Cheap-digest v1, measure, LLM pass v2; hard token caps |
| 2 | **Concurrent edits** — both agents in one cwd clobber each other | High | Phase 4 git-worktree-per-pane; until then, document the footgun |
| 3 | **Schema drift** — undocumented JSONL changes on CLI updates | Medium (certain, but contained) | Single adapter layer; per-line skip-don't-crash; version-sniff via `version`/`cli_version` |
| 4 | Title collisions / empty titles break "refer to X" | Medium | Candidates-not-answers in `search_sessions`; fallback to first-user-msg text |
| 5 | Prompt-injection exfiltration via bridge tools | Medium | §4.5; per-project allowlist |
| 6 | Sub-second freshness — mid-generation output not on disk yet | Low (by design) | Documented non-goal; app-server path if ever needed |
| 7 | Official apps overlap (Claude Code desktop/web already browse history) | Product risk | Differentiation IS the cross-model cohesion; single-tool history browsing alone is not a product |

**Open questions:**
- Session-name vs UUID: expose Codex's named-session feature in the sidebar?
- Should `handoff` support attaching arbitrary files/snippets, not just notes?
- One bridge binary with `--agent` flag vs auto-detect from the spawning client?

---

## 8. Tech Stack

- **Electron** (chosen over Swift): node-pty + xterm.js + chokidar +
  `@modelcontextprotocol/sdk` + Claude Agent SDK are all TS-native. Swift/
  SwiftTerm buys native feel at the cost of reimplementing the bridge and
  having no first-party SDK.
- Bridge: TypeScript, `@modelcontextprotocol/sdk`, stdio transport, zero
  runtime deps beyond the SDK if possible.
- No database in v1 — the JSONL files are the database; in-memory index,
  rebuilt on watch events. (Add SQLite cache only if indexing proves slow.)

---

## 9. Future Path: app-server / Agent SDK (Phase 5)

For a fully custom chat UI (no embedded terminal), both CLIs expose
programmatic surfaces:

- **Claude Code:** Claude Agent SDK (TS/Python), or
  `claude -p --input-format stream-json --output-format stream-json`
  — structured streaming events in/out; app must implement its own
  permission-approval UI.
- **Codex:** `codex app-server` (experimental JSON-RPC over stdio/ws; what the
  Codex desktop app and IDE extension use), `codex mcp-server` (drive Codex as
  an MCP tool), or `codex exec --json` for one-shot runs. The TUI can also
  attach to a remote app-server (`ws://`), enabling detached-engine designs.

This path unlocks: real-time structured rendering, programmatic input,
custom approval dialogs, true agent-to-agent loops. Cost: you own the entire
interaction surface (approvals, interrupts, slash commands). Deliberately
deferred — the embedded-terminal + bridge design delivers the cohesion goal
without it.

---

## 10. Phase 4 — Isolated terminals (worktree per agent task)

**Status:** designed & built 2026-07-17.
**Design center:** Martin runs multiple agents on the same repo
concurrently. Isolation must never disturb the main checkout, where the
long-running dev servers (frontend/api/worker) and their ports live.

### 10.1 Model

A worktree is the same repo — `git worktree add` creates a second checkout
sharing the main checkout's `.git` (same history, remotes, branches). Each
isolated terminal gets its own worktree + branch, so concurrent agents never
touch the same files. "Merging back" is just `git merge <branch>` run in the
main checkout; dev servers never move, ports never change, HMR shows the
merged result immediately.

**Worktrees are for headless work** (edit, typecheck, unit tests). Nothing
is ever *run* in a worktree except the setup command; anything the user
wants to see running is merged into main first. No port offsetting, no
per-worktree dev servers (rejected — see KNOWN-ISSUES #16).

### 10.2 Creation UX

Sidebar action `⎇` (enabled when a project is selected) → dialog:

- **Task name** (required, `[a-z0-9][a-z0-9._-]*`) — becomes branch
  `agent/<task>`, folder `~/.chewo/worktrees/<repo-basename>/<task>`, and
  the tab label `⎇ <task>`. Forcing a name is a feature: with N concurrent
  agents, "which tab is which" is the real problem.
- **Agent** — Claude / Codex.
- **Setup command** (optional, per-project, persisted as
  `project.worktreeSetup`) — e.g. `cp <main>/.env . && npm install`. Runs
  visibly in the pane, chained `(setup) && <agent>`, so a failed setup never
  launches the agent silently. Needed because gitignored files
  (`.env`, `node_modules`) don't exist in a fresh worktree.

Branched from the main checkout's current `HEAD`. Worktrees live OUTSIDE the
repo so main-checkout file watchers (Vite, nodemon) never see them.

### 10.3 Lifecycle

- **Binding/persistence:** worktree sessions bind to panes by cwd as usual;
  the worktree→project mapping (`projects.json` `worktrees[]`) keeps their
  sessions and tabs grouped under the owning project. Worktree tabs persist
  as dormant tabs (wake = resume in the worktree path) and keep their
  `⎇ <task>` label.
- **Merge (`⇤` button on worktree tabs):** modal shows dirty state,
  commits ahead of the main checkout's branch, and diffstat.
  Merge = `git merge --no-ff --no-edit agent/<task>` in the main checkout.
  Blocked while the worktree has uncommitted changes (user nudges the agent
  to commit). Conflicts → automatic `merge --abort`, error shown verbatim,
  resolution is the user's (or an agent's) job in the main checkout.
- **Cleanup:** after merge (or to abandon), "Remove worktree" runs
  `git worktree remove` + `git branch -d`. Unmerged branches survive
  (`-d` refuses; reported, never `-D`). Live panes in the worktree are
  killed first; dormant tabs are dropped; the session transcript remains
  (session stores stay read-only).

### 10.4 Explicitly not built

- Dev servers / port management in worktrees.
- Auto-detecting "agent is done" — the user decides when to merge.
- In-app conflict resolution or auto-stash of the main checkout.
- Auto-copying gitignored files (secret-leak risk; setup command instead).

### 10.5 Per-section agent launch settings (2026-07-17)

Neither CLI remembers the permission mode you flipped to last session — every
fresh spawn starts at the CLI's own default, which is why the app felt like it
"asks more" than a hand-run terminal (where the mode gets flipped by habit and
then persists for that session only).

Each section (Home and every project) stores how its agents launch:

| Setting | Flag emitted | Values |
|---|---|---|
| `claudeMode` | `--permission-mode` | `manual` · `plan` · `acceptEdits` · `auto` · `dontAsk` · `bypassPermissions` |
| `codexApproval` | `--ask-for-approval` | `untrusted` · `on-request` · `never` |

Unset = no flag = the CLI's own default. Applies to fresh spawns, resumes, woken
dormant tabs and isolated terminals alike; running panes keep the mode they
launched with. Settings live in `projects.json` (⚙ on the section row) — the
CLIs' own config files are never written (see KNOWN-ISSUES).

`projects.json` is user-editable, so values are validated against the enums in
`buildCommand` before reaching the shell; anything unrecognized is dropped.

**Rejected:** writing `permissions.defaultMode` into `~/.claude/settings.json`.
That would widen every `claude` on the machine, including fresh clones of
untrusted repos, to buy the same result. Chewo scopes the widening to the app,
where agent fleets are a deliberate act — and it's the only option that covers
Codex, whose `config.toml` we must not hand-write.
