# Chewo — notes for agents

Chewo is a macOS Electron app that unifies Claude Code and Codex CLI: one sidebar over
both session stores, real terminals (node-pty/xterm), the `chewo` MCP server, a
capabilities manager, and opt-in worktree isolation. Read `SPEC.md`,
`SPEC-CAPABILITIES.md`, `SPEC-NOTES.md` and `KNOWN-ISSUES.md` before changing
architecture.

This file is loaded into every session, so it stays an index — `CLAUDE.md` is a symlink
to it. The detail lives in `docs/notes/` and is read on demand.

## Commands

npm. `npm test` (vitest) and `npm run typecheck` are the only gates. There is no
prettier and no stylelint here, so match the surrounding style by hand.

| Command | When |
|---|---|
| `npm run dev` | electron-vite, watching |
| `npm test`, `npm run typecheck` | before calling anything done |
| `npm run postinstall` | after every `npm install <pkg>` — a targeted install strips node-pty's `spawn-helper` exec bit and every terminal dies |
| `npm install` | after any pull that touches `package.json` |
| `npm run canary:chat` | after a CLI update, to re-verify the wire format |
| `npm run dist`, `npm run dist:install` | package, or package and install locally |
| `npm version <patch\|minor\|major>` | releases — never hand-edit a `version` field |

## Layout

- `src/main/` — Electron main: git, terminals, agent runners, MCP, dictation.
- `src/renderer/` — the React UI. `src/preload/` — the bridge.
- `src/shared/` — types and helpers both sides import; keep node imports out of it.
- `packages/chewo-mcp/` — the `chewo` MCP server, shipped inside the app.
- `packages/audio-capture/` — the Swift capture sidecar.
- `tests/` vitest specs. `scripts/` build and canary scripts. `design/` locked visual direction.
- `docs/notes/` the real notes, below. `docs/decisions.md` one line per settled choice.

## Rules that hold everywhere

- **Git mutations are split by blast radius.** `src/main/git.ts` is read-only;
  `git-ops.ts` brings commits in, `git-ship.ts` sends work out, `git-discard.ts`
  destroys uncommitted work, `worktrees.ts` manages checkouts. Never `--force`,
  `-D` or `git stash` — the only exception is a discard the user was shown the
  cost of and confirmed.
- **Feature code never branches on the agent** and model lists are never
  hardcoded. Divergence lives in `src/main/agent-runner.ts` and
  `src/main/terminals.ts`; agents are described in `src/shared/agents.ts`.
- **Never forward a CLI's raw event schema to the renderer** — normalize to
  `ChatEvent`/`AgentChatEvent` in main first.
- **Verify wire-format claims against the installed CLI**, never from memory.
- **Every `var(--token)` must exist.** An unresolvable token invalidates the whole
  declaration, so a typo silently computes to 0, not to a fallback.

## Notes — read before changing an area

Entries are dated and a later one can supersede an earlier one, so take the newest.
Before changing an area, open its file. When a claim about this repo feels uncertain,
`grep -ri "<term>" docs/notes/` first. To list one file's entries:
`grep -n "^## " docs/notes/<file>.md`.

- `git-worktrees.md` — the git mutation split, worktrees, Ship, branch naming, discard, reaping.
- `chat-runtime.md` — chat panes, the CLI wire format, resumed transcripts, tool rendering.
- `agents-cli.md` — the two CLIs, subagents, the agent builder, how model and effort resolve.
- `build-and-processes.md` — install traps, packaging, updates, run panes, shells, process trees.
- `ui-design.md` — tokens, themes, accents, fonts, drag and drop, layout.
- `conventions.md` — vocabulary and standing decisions.

## Learned — where a new one goes

Append the full note to the topic file in `docs/notes/` under a
`## <date> — <lead sentence>` heading. Nothing longer than a line belongs in this file.
