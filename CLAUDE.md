# Chewo

macOS Electron app unifying Claude Code + Codex CLI: shared sidebar of both session stores, real terminals (node-pty/xterm), context-bridge MCP, capabilities manager, opt-in worktree isolation. See SPEC.md, SPEC-CAPABILITIES.md, SPEC-NOTES.md, and KNOWN-ISSUES.md (read before changing architecture).

## Learned

- 2026-07-18: Our umbrella term for one item in the tab bar is **"session"** (what you create/focus/close). Layers keep code-level names: **tab** = UI chip, **terminal** = `termId` pty runtime, **conversation** = `sessionId` CLI transcript. Vocabulary only — don't mass-rename identifiers unless asked.
- 2026-07-17: Martin always runs multiple agents concurrently in the same repo — never make isolation the default, never add "you have 2 agents here" warnings. Isolation is opt-in per terminal; dev servers always stay in the main checkout.
