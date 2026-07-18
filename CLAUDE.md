# Chewo

macOS Electron app unifying Claude Code + Codex CLI: shared sidebar of both session stores, real terminals (node-pty/xterm), context-bridge MCP, capabilities manager, opt-in worktree isolation. See SPEC.md, SPEC-CAPABILITIES.md, SPEC-NOTES.md, and KNOWN-ISSUES.md (read before changing architecture).

## Learned

- 2026-07-18: Our umbrella term for one item in the tab bar is **"session"** (what you create/focus/close). Layers keep code-level names: **tab** = UI chip, **terminal** = `termId` pty runtime, **conversation** = `sessionId` CLI transcript. Vocabulary only — don't mass-rename identifiers unless asked.
- 2026-07-17: Martin always runs multiple agents concurrently in the same repo — never make isolation the default, never add "you have 2 agents here" warnings. Isolation is opt-in per terminal; dev servers always stay in the main checkout.
- 2026-07-18: The UI/UX overhaul canon lives in `design/` — read `design/README.md` for the persona-pass process and `design/06-chosen-direction.md` for Martin's LOCKED visual direction. Direction is **Graphite base + Emerald accent** (the warm "Kiln"/terracotta values in `design/02–04` were rejected as "mustard brown"; 06 supersedes their hex, the token architecture in 04 still stands). HTML mockups in `design/mockups/`.
