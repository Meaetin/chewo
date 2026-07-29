<div align="center">

<img src="build/icon.png" alt="Chewo" width="120" />

# Chewo

**A macOS workbench that runs Claude Code and Codex CLI side by side — and lets them read each other's memory.**

`Electron` · `React` · `TypeScript` · `node-pty` / `xterm.js` · `Model Context Protocol`

</div>

---

## The problem

Claude Code and Codex CLI each keep their own session history and their own context. Working with both means copy-pasting decisions between terminals and losing track of which conversation holds what. Chewo puts both CLIs in one window, makes every past session from either tool browsable in a single sidebar, and — the core bet — lets **each model fetch and hand off the other's session history mid-conversation**.

Cross-model context is a **tool, not a pipe**: the models call MCP tools to pull what they need. The filesystem is the shared memory — no daemon, no ports, no screen-scraping.

## What it does

- **Unified session sidebar** — every Claude Code and Codex session, merged, grouped by project, searchable by title or first message, live-updating via file watchers. Click any session to resume it in its original working directory.
- **Real embedded terminals** — the actual interactive `claude` / `codex` TUIs run in `node-pty` + `xterm.js` panes. Chewo wraps the CLIs; it doesn't reimplement them.
- **Cross-model cohesion** (the spine) — a [`chewo`](packages/chewo-mcp) MCP server, bundled inside the app and registered with both CLIs from Settings → Connections (nothing to install separately, no Node runtime needed), exposes `search_sessions`, `get_session`, `list_recent_sessions`, `handoff`, and `check_inbox`, plus todo-board tools (`todos_list`, `todo_add`, `todo_move`, `todo_update`, `todo_delete`). Either agent can search the other's history, read a summarized transcript, and pass a note through a pull-based inbox.
- **Opt-in worktree isolation** — spin up a `git worktree` + branch per agent task so multiple agents edit the same repo concurrently without touching the main checkout (where the dev servers live), then merge back through a guarded flow.
- **Voice commands** — a global hotkey + a Swift audio-capture sidecar streaming to Deepgram, interpreted by your chosen agent into terminal actions.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Electron app                                                  │
│  ┌────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │  Sidebar   │   │ Claude pane │   │ Codex pane  │           │
│  │  unified   │   │ xterm.js +  │   │ xterm.js +  │           │
│  │  history   │   │ node-pty    │   │ node-pty    │           │
│  └─────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│        │                 │                 │                  │
│  ┌─────┴─────────────────┴─────────────────┴───────┐          │
│  │ Session Adapter Layer (normalizes both formats) │          │
│  └─────┬───────────────────────────────────────────┘          │
└────────┼──────────────────────────────────────────────────────┘
         ▼
  ~/.claude/projects/**   ~/.codex/sessions/**   (read-only)
         ▲                        ▲
         │      chewo MCP server (stdio)
         └── shared inbox: ~/.chewo/mcp/inbox/<agent>/*.json
```

A single **session-adapter layer** normalizes two undocumented, drift-prone on-disk formats — Claude's `parentUuid` message tree and Codex's OpenAI-Responses rollouts — into one model. Parsing is per-line skip-don't-crash, so a CLI update that changes the schema degrades gracefully instead of taking the app down. The same parser feeds both the sidebar and the bridge, so there's one fix point.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron + `electron-vite` |
| UI | React 19 + TypeScript |
| Terminals | `node-pty` + `@xterm/xterm` |
| File watching | `chokidar` |
| Cross-agent bridge | `@modelcontextprotocol/sdk` (stdio) |
| Voice sidecar | Swift + Core Audio (`packages/audio-capture`) — capture only |
| Speech-to-text | Deepgram streaming (`@deepgram/sdk`), key in the macOS Keychain |

No database — the CLIs' JSONL session files *are* the database; the index is built in memory and rebuilt on watch events.

## Status

Early, single-developer project — **v0.1.0**, macOS (Apple Silicon) only. Built as a personal daily driver, so it prioritizes the workflows I actually use over broad coverage.

### Security note

The MCP server exposes the user's session history to any agent that can call its tools, which is a prompt-injection surface (a malicious repo could try to exfiltrate other sessions). This is why connecting it is an explicit opt-in per CLI rather than something the app arranges on first launch. Current mitigations: the server is **read-only** over history, `handoff` writes only to its own inbox, and every tool call is logged to `~/.chewo/mcp/audit.log`. A per-project allow/deny list is the next step.

## Running from source

Requires macOS with the `claude` and `codex` CLIs installed and a recent Node.js.

```bash
npm install
npm run dev          # electron-vite dev with hot reload

npm run typecheck    # tsc --noEmit
npm test             # vitest

npm run dist         # build an ad-hoc-signed .app into dist/ (Apple Silicon)
```

---

<div align="center">
<sub>Not affiliated with Anthropic or OpenAI. Chewo orchestrates their CLIs; it doesn't ship or replace them.</sub>
</div>
