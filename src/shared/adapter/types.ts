import type { AgentTask } from '../tool-tasks'
import type { ToolPatch } from '../diff'
import type { ToolImage } from '../tool-images'

export type Source = 'claude' | 'codex'

export interface SessionMeta {
  id: string
  source: Source
  title: string
  /** Absolute cwd the session ran in, when recoverable */
  project: string | null
  gitBranch?: string
  createdAt: string
  updatedAt: string
  filePath: string
  /** Count of real conversation messages across the whole session history —
   *  slash-command chips excluded, so command-only sessions (e.g. a lone
   *  /clear) count 0 and are hidden. Counts every main-branch message ever
   *  written (not just the active branch after rewinds), so it never dips to 0
   *  mid-write and a live session can't flicker out of the sidebar. */
  messageCount: number
  /** First real user message, truncated — for search and sidebar subtitles */
  preview: string
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** Set when this is a slash-command invocation (e.g. "/clear") — render as a chip */
  commandName?: string
  toolName?: string
  /** Human label for the tool chip when the wire name is implementation detail. */
  toolDisplayName?: string
  /** Structured arguments for the tool chip's one-line summary. */
  toolInput?: unknown
  /** Output of the tool call, when recoverable — capped, render collapsed */
  toolResult?: string
  /** The diff a file-editing tool applied, when the record kept one */
  toolPatch?: ToolPatch
  /** Pictures the tool handed back, budgeted newest-first — see `SEED_IMAGE_BUDGET` */
  toolImages?: ToolImage[]
  filesTouched?: string[]
  timestamp?: string
  isSidechain?: boolean
}

export interface ParseStats {
  linesTotal: number
  /** Lines that failed JSON.parse */
  linesUnparseable: number
  /** Top-level record types we don't recognize (forward-compat signal), with counts */
  unknownTypes: Record<string, number>
}

export interface ParseResult {
  meta: SessionMeta
  /**
   * The context the conversation was last sitting at, from the newest
   * main-branch assistant record's own `usage`. A resumed pane would otherwise
   * show nothing at all until the user spoke — the CLI replays no history on
   * `--resume`, so the first live reading is a turn away. Absent for a
   * transcript that never recorded one.
   */
  contextTokens?: number
  /**
   * The model and reasoning effort the conversation was last running on, read
   * off its newest turn — Claude records both on every assistant record,
   * Codex on every `turn_context`. A resumed session spawns with no model or
   * effort flag, and neither CLI announces what it settled on until a turn
   * ends, so this is the only thing that can tell the composer what it is
   * about to speak on. Absent for a transcript that never recorded a turn.
   */
  model?: string
  effort?: string
  /**
   * The agent's plan as the transcript last left it. Resuming replays nothing,
   * so a pane that had a plan going would otherwise come back without one.
   */
  tasks?: AgentTask[]
  messages: NormalizedMessage[]
  stats: ParseStats
}

export interface ScanResult {
  sessions: SessionMeta[]
  /** Files that could not be parsed at all */
  errors: string[]
  /** Aggregated unknown record types across all files */
  unknownTypes: Record<string, number>
}
