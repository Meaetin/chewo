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
  messageCount: number
  /** First real user message, truncated — for search and sidebar subtitles */
  preview: string
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
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
