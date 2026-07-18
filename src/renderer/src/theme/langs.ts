import { langNames, loadLanguage, type LanguageName } from '@uiw/codemirror-extensions-langs'
import type { Extension } from '@uiw/react-codemirror'

/**
 * The langs package keys ARE file extensions (ts, tsx, py, rs, md, …), so
 * resolution is a membership check; only shells need aliasing.
 */
const ALIASES: Record<string, LanguageName> = { zsh: 'bash', fish: 'sh' }

const KNOWN = new Set<string>(langNames)

export function languageFor(fileName: string): Extension | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const name = ALIASES[ext] ?? (KNOWN.has(ext) ? (ext as LanguageName) : null)
  return name ? loadLanguage(name) : null
}
