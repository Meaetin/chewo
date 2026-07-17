# Decisions

- 2026-07-17 — Worktree isolation is **opt-in per terminal**, not the default. Martin deliberately runs multiple agents in one checkout; the main checkout keeps the dev servers/ports. Rejected: default-isolation, concurrency badge, per-worktree dev servers / port offsetting.
- 2026-07-17 — Worktrees are headless scratch buffers: merge back into the main checkout to see anything running. Setup command (per-project, user-authored) instead of auto-copying gitignored files — secret-leak risk.
