# 01 — Current State Audit (2026-07-18)

Audit of the rendered UI as of commit `3e75a0e`. Personas: critique this
reality, not an imagined app. File references are clickable anchors into the
codebase.

The app is a single `BrowserWindow` (standard title bar, `backgroundColor:
#16161e` — `src/main/index.ts:52`). Renderer is React + Vite with one global
stylesheet. There is **no router** — the app is driven by a `MainView` union
and a `workflow` flag in `src/renderer/src/App.tsx`; all panels are
conditionally rendered inside one flex layout.

## 1. Screen / surface map

Root layout: two-column flex — fixed 300px `.sidebar-column` + flexible
`.main-panel` (`App.tsx:701-742`, `styles.css:34-49`). Top-level `workflow`
state (`'code'` | `'notes'`) swaps both columns' contents.

### Always-present chrome
- **Workflow Switcher** — `WorkflowSwitcher.tsx`, styled `styles.css:58-84`.
  Two-button segmented control ("</> Code" / "✎ Notes") pinned atop the
  sidebar column. The only always-visible global nav.

### Code workflow

| Surface | Contents | Files |
|---|---|---|
| **Sidebar (coding)** | Action row (+ Claude, + Codex, ⎇ isolated, ⛭ capabilities), global session search, Home section, Projects list (collapsible, per-project session groups, "Show more"), Hidden section. Rows carry CC/CX badges, live dots, relative timestamps, ⚙ settings, ✕ hide. | `Sidebar.tsx`; `styles.css:39-305` |
| **Terminal tab bar** | Chrome-style bottom-aligned tabs for the selected section's live terminals + dormant "ghost" tabs + far-right "+" new-shell button. Tabs show source badge, label, ⇤ merge (worktree only), × close. | `App.tsx:743-823`; `styles.css:367-486` |
| **Terminal pane** | xterm.js terminal, one per tab, all kept mounted (`display:none` when inactive) so processes keep running. Per-pane ⌘+/−/0 font zoom. | `TerminalPane.tsx`; `styles.css:1687-1692` |
| **Empty state** | Centered heading + hint when nothing is open. | `App.tsx:870-879`; `styles.css:1005-1013` |
| **Transcript view** | Read-only session replay: header (title, source badge, project path, git branch, ▶ Resume), ⌘F find bar with CSS Custom Highlights, message list (user text literal, assistant markdown, expandable tool-call chips, slash-command chips). | `TranscriptView.tsx`; `styles.css:1015-1341` |
| **Capabilities view** | Full-panel scrollable audit of skills/subagents/instructions/hooks/MCP per scope, as cards with "Copy to…" / "View" actions. Replaces main content inline (not a modal). | `CapabilitiesView.tsx:211-376`; `styles.css:1343-1523` |

### Notes workflow

| Surface | Contents | Files |
|---|---|---|
| **Notes sidebar** | OneNote metaphor: Subjects → Topics, collapsible, inline name-input creation, counts. | `NotesSidebar.tsx`; `styles.css:1696-1744` |
| **Notes workspace** | 230px page (lesson) list with ⎘ paste / + new, plus editor pane: title input, Edit/Preview toggle, CodeMirror markdown editor (autosave). Top bar: breadcrumb, ✦ Ask, ● Record. | `NotesWorkspace.tsx`; `styles.css:1746-1925` |
| **Recording / dictation panel** | While recording, editor splits into Note / Live-transcript tabs; level meter, streaming transcript, pulsing ● dot, elapsed clock, ■ Stop, structuring status rows. | `NotesWorkspace.tsx:175-243`; `styles.css:1927-2067` |
| **Notes Q&A chat** | 340px right rail, toggled; scope `<select>` (all/subject/topic), markdown message list, textarea + send/stop. Headless Claude session. | `NotesChat.tsx`; `styles.css:2069-2205` |
| **Notes empty state** | Prompt to pick a topic + "✦ Ask your notes" button. | `App.tsx:844-859` |

### Modals / popovers / overlays

| Surface | Trigger | Files |
|---|---|---|
| Worktree Create modal | ⎇ isolated-terminal button | `WorktreeModals.tsx:18-138` (via `ModalShell.tsx`) |
| Worktree Merge modal | ⇤ on a worktree tab | `WorktreeModals.tsx:149-325` |
| Section Settings modal | ⚙ on Home/project row | `SectionSettingsModal.tsx` — uses custom `Select.tsx` |
| Capabilities "Copy to…" modal | "Copy to…" on any capability | `CapabilitiesView.tsx:394-526` — **own** `copy-modal-*` chrome, not `ModalShell` |
| Memory viewer modal | Click a CLAUDE.md/AGENTS.md row | `CapabilitiesView.tsx:378-392` — **own** `memory-viewer` chrome |
| Custom Select popover | Settings dropdowns | `Select.tsx` — portalled to `<body>`, `styles.css:802-897` |
| Toast | Handoffs, errors, STT status | `App.tsx:899-903`; `styles.css:1667-1683` |
| Native `window.confirm` | Worktree/project removal, overwrite | `CapabilitiesView.tsx:187`, `WorktreeModals.tsx:197`, `SectionSettingsModal.tsx:78` |

## 2. Navigation & flow

- **Top-level mode** is the WorkflowSwitcher (Code ⇆ Notes). Switching swaps
  both columns but keeps terminal panes mounted (`App.tsx:889-896`).
- **Within Code**, the sidebar is primary nav. Selecting a project =
  expanding it (selection ⟺ expansion ⟺ its tabs show, `Sidebar.tsx:180`).
  Clicking a session focuses its live terminal or opens its transcript
  (`App.tsx:323-334`). The main panel is a single-slot view
  (`transcript` | `terminal` | `capabilities` | `empty`), never split.
- **Capabilities** takes over the whole main panel (sidebar ⛭ opens, × closes)
  — modal-like but rendered inline, so the tab bar stays above it.
- **Modals** are true overlays (fixed backdrop, Esc/backdrop-close via
  `ModalShell`; the Capabilities modals reimplement this themselves).
  `window.confirm` stacks on top.
- **Notes** mirrors the structure: sidebar picks subject→topic, workspace picks
  lesson, chat is a toggleable right rail.
- **Persistent:** WorkflowSwitcher, sidebar, tab bar (Code only).
  **Toggling:** notes chat, find bar, section expansion, hidden section.
  **Modal:** all settings/worktree/copy dialogs.

## 3. Current styling approach

- **Single global CSS file**: `src/renderer/src/styles.css` (2,205 lines),
  plain hand-written CSS, imported once in `main.tsx:4`. No Tailwind,
  no CSS-in-JS, no CSS modules. Inline styles only for dynamics
  (`display` toggles, level-meter width, Select popover position).
- **Tokens** — one `:root` block, `styles.css:7-18`: `--bg`, `--bg-panel`,
  `--bg-hover`, `--bg-selected`, `--border`, `--text`, `--text-dim`,
  `--accent-claude` (#d97757), `--accent-codex` (#6ba4f8), `--accent-live`
  (#34d399). **That is the entire token set** — no spacing, radius, font-size,
  or shadow tokens.
- **Theming:** dark only, no `prefers-color-scheme`. CodeMirror hardcodes
  `theme="dark"` (`NotesWorkspace.tsx:155`); xterm hardcodes
  `theme:{background:'#16161e'}` (`TerminalPane.tsx:23`) — a literal duplicate
  of `--bg`; window `backgroundColor` duplicates it again (`index.ts:56`).
- **Fonts:** UI = `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  (`styles.css:27`). Mono = `'SF Mono', Menlo, monospace` repeated as a string
  literal ~10 times (`styles.css:566,660,676,798,955,973,1118,1143,1220,1912`,
  plus `TerminalPane.tsx:21`) — no token.
- **Hardcoded colors outside the tokens:** `#e06c75` danger ×6, `#e5c07b`
  warning ×3, one-off `#ef7f88`, `#e88b92`; `#fff` ×5. Danger/warning are
  semantically important yet never tokenized.
- **Spacing/radius: no scale.** Radii in use: 3,4,5,6,7,8,10,12px. Paddings ad
  hoc (`6px 12px`, `7px 12px`, `7px 14px`, `8px 10px`, `8px 16px`, `10px 16px`,
  `14px 18px`, `16px 18px`, `12px 14px`…). Fractional font sizes `11.5px`/
  `12.5px` (`styles.css:672,893,986`).

## 4. Component inventory

**Genuinely reusable:**
- `ModalShell.tsx` — shared header/body/footer + Esc/backdrop. Used by
  worktree + settings modals only (Capabilities ignores it).
- `Select.tsx` — custom portalled dropdown with keyboard nav. Used only in
  Section Settings.
- Source badges (`.source-badge-{claude,codex,shell}`) — the one consistent
  primitive (CC/CX/SH), used across sidebar, tabs, transcript, capabilities,
  modals.
- `SessionRow`/`SessionGroup` (local to `Sidebar.tsx:47-156`) — reused for
  Home/project/hidden/search.

**One-off markup (not componentized):** terminal tab bar and tabs
(`App.tsx:744-822`), capabilities cards, copy modal, toast, empty states.

**Buttons — ~15 distinct classes, no `Button` component:**
- Sidebar: `.new-terminal-button`, `.worktree-new-button`,
  `.capabilities-button`, `.project-add-button`, `.new-shell-button`,
  `.show-more-button`.
- Primary/CTA has three different treatments: `.resume-button` (accent fill,
  `filter:brightness(1.1)` hover, `styles.css:1045-1058`), `.wt-button-primary`
  (accent fill, `color-mix` hover, `styles.css:734-743`), `.copy-modal-apply`
  (accent fill, **no hover state**, `styles.css:1596-1609`).
- Close buttons differ per surface: `.capabilities-close-button` (boxed),
  `.wt-modal-close` (borderless ×), memory viewer reuses `.terminal-tab-close`
  (`CapabilitiesView.tsx:383`).
- Notes has its own set: `.notes-mode-button`, `.notes-record-lesson-button`,
  `.recording-stop-button`, `.notes-chat-send`.

**Inputs:** ~7 near-identical text-input styles with no shared base —
`.session-search-input`, `.wt-input`, `.notes-add-input`, `.notes-chat-input`,
`.notes-title-input`, `.find-input`, `.notes-chat-scope`. Focus states
inconsistent (some `border-color:var(--accent-codex)`, most just
`outline:none`).

**Dropdowns:** Section Settings uses custom `Select`; NotesChat scope uses a
raw native `<select>` (`NotesChat.tsx:144-153`) — the exact problem `Select`
was built to solve.

**Lists/rows:** `.project-row`, `.session-item`, `.notes-topic-row`,
`.note-page-row`, `.capability-row` — same hover/selected pattern, duplicated
CSS each time.

**Tooltips:** none custom — native `title=""` attributes everywhere.

## 5. Rough edges (designer flags)

1. **Two parallel modal systems.** `ModalShell` (`wt-modal-*`, radius 12,
   backdrop `rgba(0,0,0,0.6)`) vs Capabilities' `copy-modal-*`/`memory-viewer`
   (backdrop `0.55`/`0.5`, different close buttons, no shared Esc handling).
2. **Selection accent semantically inconsistent.** Project rows highlight blue
   `--accent-codex` (`styles.css:159`); session items and notes rows highlight
   orange `--accent-claude` (`styles.css:270,1715,1816`). No rule for what each
   accent means.
3. **"Live" uses two colors.** `.session-live-dot` green (`styles.css:449`) but
   `.project-row-live` count orange (`styles.css:442`) — same concept.
4. **Danger/warning hardcoded, not tokenized** — scattered across worktree
   banners/buttons and errors (`styles.css:682,746-783,1341`).
5. **Emoji + glyph soup, no icon system.** Unicode glyphs (⎇ ⛭ ⚙ ⇤ ⎘ ✦ ↻ ⟳ ■
   ▶ ▸▾ ↩ ●) and literal emoji (🔑 `CapabilitiesView.tsx:363,448`, ⚠ `:440`).
   Render inconsistently, can't be styled as a set.
6. **Standard macOS title bar over a dark app.** No `titleBarStyle:
   'hiddenInset'` (`index.ts:52-64`) — a default OS title bar with "Chewo"
   sits above the custom dark chrome.
7. **Dead CSS.** `.notes-record-button` (`styles.css:1781-1796`) defined,
   used nowhere.
8. **Thin loading/empty states.** Loading is bare text ("Loading…",
   "Scanning…", "Structuring…") — no skeletons or spinners anywhere. Empty
   states are well-written but plain centered text.
9. **`copy-modal-apply` has no hover/active feedback** (`styles.css:1596`) —
   feels dead.
10. **Fixed widths everywhere:** sidebar 300, notes pages 230, notes chat 340,
    tab max 220, capabilities column capped at magic `880`/`844`
    (`styles.css:1374,1407`). Nothing adapts to narrow windows.
11. **Dense, arrhythmic type scale** (10 → 16px with 11.5/12.5 in the mix);
    many 11px dim labels differ only slightly from 12px body.
12. **Mono font-family literal repeated ~11 places** — guaranteed drift.
13. **Recording UX split across two bars** with overlapping status text
    ("Structuring…" appears in both — `NotesWorkspace.tsx:400` & `:214`).
14. **Live vs ghost tabs** distinguished only by `opacity:0.5` + ▶ prefix
    (`styles.css:213`, `App.tsx:789`) — easy to miss.

## Suggested starting points

- `styles.css:7-18` — extend tokens (spacing/radius/type/shadow scales;
  tokenize danger/warning/mono font; single source of truth for the bg shared
  with xterm/CodeMirror/window).
- Unify modals on `ModalShell` (migrate `CapabilitiesView.tsx:378-526`).
- Real `Button` and `Input` primitives to collapse ~15 button / ~7 input
  variants.
- Replace native `<select>` in `NotesChat.tsx:144` with `Select`.
- Decide one accent semantics (source vs selection vs live) and apply it
  consistently.
