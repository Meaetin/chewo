# Capabilities Manager — SPEC (Phase C)

**Goal:** per-project visibility and management of what each agent can do —
instructions (CLAUDE.md / AGENTS.md), skills, subagents, MCP servers — for
both Claude Code and Codex, with copy/install across projects
(one / few / all) and from personal (global) scope.

**Status:** BUILT — C1 (inventory) through C4 (MCP copying) shipped
2026-07-17. Remaining deferred item: memory-file merge with diff preview
(§2). Verified against this machine (CC 2.1.211, codex 0.142.5).

---

## 1. Ground truth: where capabilities live

| Capability | Claude Code — global | Claude Code — project | Codex — global | Codex — project |
|---|---|---|---|---|
| Instructions/memory | `~/.claude/CLAUDE.md` | `<proj>/CLAUDE.md` (+ nested) | `~/.codex/AGENTS.md` | `<proj>/AGENTS.md` |
| Skills | `~/.claude/skills/<name>/SKILL.md` | `<proj>/.claude/skills/` | `~/.codex/skills/` | `<proj>/.codex/skills/` (also scans `.agents/skills/` cwd→repo root) |
| Subagents | `~/.claude/agents/*.md` | `<proj>/.claude/agents/*.md` | — (no equivalent) | — |
| MCP servers | `mcpServers` in `~/.claude.json` (user scope) | `<proj>/.mcp.json` (project scope) + per-project entries in `~/.claude.json` | `[mcp_servers.*]` in `~/.codex/config.toml` | **none — Codex MCP is global-only** |
| Rules/other | plugins, hooks | `.claude/settings.json` | `~/.codex/rules/*.rules`, plugins/marketplaces | `.codex/environments/` |

Observed locally: Argo = 10 CC agents, 4 CC skills, CLAUDE.md + AGENTS.md;
creature9 = 5 skills (gsap-*), both memory files; Jacker = CLAUDE.md only;
chewo = nothing yet. Global CC = 4 skills, 0 agents; global Codex = 1 skill.

**The enabling fact:** `SKILL.md` (folder + YAML frontmatter `name`,
`description`, optional scripts/references) is a cross-agent standard — the
same folder works in CC and Codex skill dirs unmodified. Codex additionally
reads an optional `openai.yaml` for Codex-specific metadata; harmless to CC.

## 2. Feasibility verdict

| Feature | Verdict | Why |
|---|---|---|
| View per-project inventory (both tools) | ✅ easy | All read-only file/config parsing — same pattern as the session adapter |
| Copy skills project↔project, global→project, one/few/all | ✅ easy | `cp -r` of self-contained folders into well-known dirs we own writing to |
| Cross-tool skill install (CC skill → Codex, vice versa) | ✅ | Shared SKILL.md standard |
| Copy CC subagents across projects | ✅ | Single portable .md files; **CC-only** (Codex has no subagent concept) |
| View / duplicate CLAUDE.md / AGENTS.md | ✅ view+copy; ⚠️ merge | Copying whole files to projects lacking one is safe; *merging* rule blocks into existing files needs diff-preview UX — defer |
| MCP: view everywhere | ✅ | Read `~/.claude.json`, `.mcp.json`, `config.toml` |
| MCP: add/copy per-project | ⚠️ CC only | CC: write `<proj>/.mcp.json` or shell `claude mcp add --scope project`. **Codex: global-only** — UI must show this, offer global install instead |
| MCP secrets | 🚫 guard | Server entries may carry env/keys — copying must strip or prompt, never silently duplicate secrets |

Overall: **possible, with two hard constraints** (no Codex per-project MCP,
no Codex subagents) and one UX-sensitive area (memory-file merging).

## 3. Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Renderer: "Capabilities" view (per project + Personal)     │
│  Instructions | Skills | Agents | MCP  — badges CC/CX/both │
│  actions: Copy to… (multi-select targets) · Install from…  │
└──────────────┬────────────────────────────────────────────┘
               │ IPC
┌──────────────┴────────────────────────────────────────────┐
│ Capability Adapter (src/shared/capabilities/) — read-only  │
│  scan(projects) → CapabilityInventory per scope            │
│  parses SKILL.md/agent frontmatter, memory files, MCP cfgs │
├───────────────────────────────────────────────────────────┤
│ Copy Engine (src/main/capability-writer.ts) — the ONLY     │
│ writer, with hard rules:                                   │
│  • skills/agents: cp -r into target dirs; collision → ask  │
│  • memory files: whole-file duplicate only (v1)            │
│  • MCP: shell out to `claude mcp add` / `codex mcp add` —  │
│    NEVER hand-write ~/.claude.json or config.toml (both    │
│    are live-rewritten by their CLIs; clobber race)         │
│  • never delete; overwrite requires explicit confirm       │
└───────────────────────────────────────────────────────────┘
```

Data model sketch:

```ts
interface CapabilityInventory {
  scope: { kind: 'global'; tool: 'claude' | 'codex' } | { kind: 'project'; path: string }
  memory: { claudeMd?: FileRef; agentsMd?: FileRef }
  skills: SkillRef[]     // { name, description, dir, tools: ('claude'|'codex')[] }
  agents: AgentRef[]     // CC only
  mcp: McpRef[]          // { name, command, scope, tool }
}
```

Copy matrix UI (the "pick and choose" ask): rows = capabilities, columns =
projects + Personal(CC) + Personal(Codex), cells = installed?/checkbox.
Apply = batched copy-engine calls, results toast.

## 4. Risks & rules

1. **Config clobber race** — `~/.claude.json` and `config.toml` are
   rewritten by live CLI sessions. Rule: all MCP writes go through the
   official CLIs; file-writes only for `.mcp.json` (CC reads it fresh, not
   rewritten) and skill/agent/memory files.
2. **Secrets in MCP entries** — strip `env` on copy, prompt to re-enter.
3. **Name collisions** — a project skill can shadow a global/plugin skill;
   inventory should show shadowing; copies never overwrite silently.
4. **Plugin-provided skills** (CC plugins, Codex marketplaces) are
   *installed artifacts* — show them read-only in v1, exclude from copying
   (owned by plugin managers, not us).
5. **Running sessions won't see new capabilities** until next session —
   surface that in the UI after a copy.
6. Schema drift applies here too (esp. `config.toml` layout) — same
   skip-don't-crash parsing discipline as the session adapter.

## 5. Build order

- **C1 — read-only inventory** (adapter + Capabilities view per project):
  proves parsing, immediately useful ("what does creature9 have again?").
- **C2 — skills/agents copy engine** + multi-target picker (the core ask).
- **C3 — memory files**: view, duplicate-to-missing; merge UX deferred.
- **C4 — MCP**: view all; add/copy via CLI shell-outs; Codex global-only
  clearly labeled; secrets guard.
