# Decisions

- 2026-07-17 — Worktree isolation is **opt-in per terminal**, not the default. Martin deliberately runs multiple agents in one checkout; the main checkout keeps the dev servers/ports. Rejected: default-isolation, concurrency badge, per-worktree dev servers / port offsetting.
- 2026-07-17 — Worktrees are headless scratch buffers: merge back into the main checkout to see anything running. Setup command (per-project, user-authored) instead of auto-copying gitignored files — secret-leak risk.
- 2026-07-17 — Permission mode is a **per-section Chewo setting** (`--permission-mode` / `--ask-for-approval` per spawn), not `permissions.defaultMode` in `~/.claude/settings.json`. Why: the global route widens every repo on the machine including fresh untrusted clones, and can't cover Codex without hand-writing `config.toml` (forbidden — live-rewritten). Diagnosis: neither CLI remembers the mode you flip to, so Chewo's many fresh sessions always started at the default.
- 2026-07-17 — Home is a first-class section, not a fallback. Sessions map to their owning section only; nothing inherits the currently-selected project.
