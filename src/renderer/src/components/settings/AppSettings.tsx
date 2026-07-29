import { useEffect, useState } from 'react'
import { Bot, FileCode, NotebookPen, Palette, Sparkles, SquareTerminal, X } from 'lucide-react'
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type EditorSyntaxColors,
  type NotesColors,
  type TerminalAnsiColors
} from '../../../../shared/appearance'
import { CURATED_ACCENTS, CURATED_BASES, matchPreset, type ThemePreset } from '../../../../shared/presets'
import { DEFAULT_AGENTS, type AgentAssignments } from '../../../../shared/agents'
import { Button, IconButton } from '../ui'
import { ColorField } from './ColorField'
import { PresetGallery } from './PresetGallery'
import { AppPreview } from './AppPreview'
import { TerminalPreview } from './TerminalPreview'
import { EditorPreview } from './EditorPreview'
import { NotesPreview } from './NotesPreview'
import { AgentsTab } from './AgentsTab'

const TERMINAL_FIELDS: Array<{ key: keyof TerminalAnsiColors; label: string }> = [
  { key: 'black', label: 'Black' },
  { key: 'brightBlack', label: 'Bright black' },
  { key: 'red', label: 'Red' },
  { key: 'brightRed', label: 'Bright red' },
  { key: 'green', label: 'Green' },
  { key: 'brightGreen', label: 'Bright green' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'brightYellow', label: 'Bright yellow' },
  { key: 'blue', label: 'Blue' },
  { key: 'brightBlue', label: 'Bright blue' },
  { key: 'magenta', label: 'Magenta' },
  { key: 'brightMagenta', label: 'Bright magenta' },
  { key: 'cyan', label: 'Cyan' },
  { key: 'brightCyan', label: 'Bright cyan' },
  { key: 'white', label: 'White' },
  { key: 'brightWhite', label: 'Bright white' }
]

const EDITOR_FIELDS: Array<{ key: keyof EditorSyntaxColors; label: string }> = [
  { key: 'keyword', label: 'Keywords' },
  { key: 'string', label: 'Strings' },
  { key: 'number', label: 'Numbers & constants' },
  { key: 'function', label: 'Functions' },
  { key: 'type', label: 'Types & classes' },
  { key: 'tag', label: 'Tags' },
  { key: 'attribute', label: 'Attributes' },
  { key: 'property', label: 'Properties' },
  { key: 'punctuation', label: 'Punctuation' },
  { key: 'comment', label: 'Comments' },
  { key: 'regexp', label: 'Regex & escapes' },
  { key: 'link', label: 'Links' },
  { key: 'invalid', label: 'Invalid' }
]

const NOTES_FIELDS: Array<{ key: keyof NotesColors; label: string }> = [
  { key: 'heading', label: 'Headings' },
  { key: 'link', label: 'Links' },
  { key: 'code', label: 'Inline code' },
  { key: 'quote', label: 'Blockquotes' }
]

/**
 * One pane per sidebar row. Adding a settings area is a new entry in NAV plus
 * a body block below — the nav renders itself from this list, so there is no
 * second place to register a pane.
 */
type Pane = 'presets' | 'app' | 'terminal' | 'editor' | 'notes' | 'agents'

interface NavItem {
  id: Pane
  label: string
  icon: typeof Palette
  /** Shown under the pane title */
  blurb: string
}

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Appearance',
    items: [
      { id: 'presets', label: 'Presets', icon: Sparkles, blurb: 'Start from a complete theme.' },
      {
        id: 'app',
        label: 'App',
        icon: Palette,
        blurb: 'Every surface, border, text level and highlight derives from these four.'
      },
      {
        id: 'terminal',
        label: 'Terminal',
        icon: SquareTerminal,
        blurb:
          'ANSI palette for every terminal. Background follows Base; cursor and selection follow Accent.'
      },
      {
        id: 'editor',
        label: 'Editor',
        icon: FileCode,
        blurb:
          'Syntax highlighting in the file editor and the notes editor (edit mode). The rendered notes preview is themed under Notes.'
      },
      {
        id: 'notes',
        label: 'Notes',
        icon: NotebookPen,
        blurb:
          'Markdown accents in the lesson preview. Surfaces and text follow Base; these color headings, links, inline code and blockquotes.'
      }
    ]
  },
  {
    group: 'Features',
    items: [
      {
        id: 'agents',
        label: 'Agents',
        icon: Bot,
        blurb:
          'Which CLI runs each AI feature. The agent must already be installed and signed in — Chewo shells out to it, it does not carry its own API key.'
      }
    ]
  }
]

const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items)

/** Terminal ANSI colors pair normal/bright, so the grid reads as two columns. */
const TERMINAL_COLUMNS = ['Normal', 'Bright']

interface AppSettingsProps {
  appearance: AppearanceSettings
  /** Live-applies — every change re-themes the app immediately */
  onChange: (a: AppearanceSettings) => void
  agents: AgentAssignments
  onAgentsChange: (a: AgentAssignments) => void
  onClose: () => void
}

/** Full-screen settings: appearance (presets + live previews) and agents. */
export function AppSettings({
  appearance,
  onChange,
  agents,
  onAgentsChange,
  onClose
}: AppSettingsProps): React.JSX.Element {
  const [pane, setPane] = useState<Pane>('presets')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (patch: Partial<AppearanceSettings>): void => onChange({ ...appearance, ...patch })
  const setTerminal = (key: keyof TerminalAnsiColors, hex: string): void =>
    set({ terminal: { ...appearance.terminal, [key]: hex } })
  const setEditor = (key: keyof EditorSyntaxColors, hex: string): void =>
    set({ editor: { ...appearance.editor, [key]: hex } })
  const setNotes = (key: keyof NotesColors, hex: string): void =>
    set({ notes: { ...appearance.notes, [key]: hex } })

  const activePreset = matchPreset(appearance)
  const current = NAV_ITEMS.find((i) => i.id === pane) ?? NAV_ITEMS[0]

  const applyPreset = (preset: ThemePreset): void => onChange(preset.appearance)

  return (
    <div className="settings-view">
      <header className="settings-view-header">
        <div className="settings-view-title">Settings</div>
        <IconButton label="Close (Esc)" tooltipSide="bottom" onClick={onClose}>
          <X size={20} strokeWidth={1.75} />
        </IconButton>
      </header>

      <div className="settings-view-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          {NAV.map((group) => (
            <div key={group.group} className="settings-nav-group">
              <div className="settings-nav-group-title">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`settings-nav-item ${
                    pane === item.id ? 'settings-nav-item-active' : ''
                  }`}
                  aria-current={pane === item.id}
                  onClick={() => setPane(item.id)}
                >
                  <item.icon size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="settings-nav-item-label">{item.label}</span>
                  {item.id === 'presets' && activePreset === null && (
                    <span className="settings-nav-item-badge">Custom</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-view-main">
          <div className="settings-pane-header">
            <h2 className="settings-pane-title">{current.label}</h2>
            <p className="settings-pane-blurb">{current.blurb}</p>
          </div>

          <div className="settings-view-body">
            {pane === 'agents' && <AgentsTab agents={agents} onChange={onAgentsChange} />}

            {pane === 'presets' && <PresetGallery selectedId={activePreset} onPick={applyPreset} />}

            {pane === 'app' && (
              <div className="settings-split">
                <div className="settings-controls">
                  <div className="settings-pane-actions">
                    <Button
                      intent="secondary"
                      onClick={() =>
                        set({
                          base: DEFAULT_APPEARANCE.base,
                          accent: DEFAULT_APPEARANCE.accent,
                          accentSecondary: DEFAULT_APPEARANCE.accentSecondary,
                          accentTertiary: DEFAULT_APPEARANCE.accentTertiary
                        })
                      }
                    >
                      Reset section
                    </Button>
                  </div>
                  <ColorField
                    label="Base"
                    hint="Window background — surfaces + text ramp derive from it"
                    value={appearance.base}
                    swatches={CURATED_BASES}
                    onChange={(hex) => set({ base: hex })}
                  />
                  <ColorField
                    label="Accent"
                    hint="Buttons, selection, focus, cursors"
                    value={appearance.accent}
                    swatches={CURATED_ACCENTS}
                    onChange={(hex) => set({ accent: hex })}
                  />
                  <ColorField
                    label="Secondary accent"
                    hint="Expanded project highlight in the sidebar"
                    value={appearance.accentSecondary}
                    swatches={CURATED_ACCENTS}
                    onChange={(hex) => set({ accentSecondary: hex })}
                  />
                  <ColorField
                    label="Tertiary accent"
                    hint="Live / running indicators"
                    value={appearance.accentTertiary}
                    swatches={CURATED_ACCENTS}
                    onChange={(hex) => set({ accentTertiary: hex })}
                  />
                </div>
                <div className="settings-preview">
                  <AppPreview />
                </div>
              </div>
            )}

            {pane === 'terminal' && (
              <div className="settings-split">
                <div className="settings-controls">
                  <div className="settings-pane-actions">
                    <Button
                      intent="secondary"
                      onClick={() => set({ terminal: DEFAULT_APPEARANCE.terminal })}
                    >
                      Reset section
                    </Button>
                  </div>
                  {/* TERMINAL_FIELDS alternates normal/bright, so a 2-column grid
                      lands each pair side by side under these headers. */}
                  <div className="settings-color-grid settings-color-grid-labelled">
                    {TERMINAL_COLUMNS.map((c) => (
                      <div key={c} className="settings-color-grid-head">
                        {c}
                      </div>
                    ))}
                    {TERMINAL_FIELDS.map(({ key, label }) => (
                      <ColorField
                        key={key}
                        label={label.replace(/^Bright /, '')}
                        value={appearance.terminal[key]}
                        onChange={(hex) => setTerminal(key, hex)}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-preview">
                  <TerminalPreview appearance={appearance} />
                </div>
              </div>
            )}

            {pane === 'editor' && (
              <div className="settings-split">
                <div className="settings-controls">
                  <div className="settings-pane-actions">
                    <Button
                      intent="secondary"
                      onClick={() => set({ editor: DEFAULT_APPEARANCE.editor })}
                    >
                      Reset section
                    </Button>
                  </div>
                  <div className="settings-color-grid">
                    {EDITOR_FIELDS.map(({ key, label }) => (
                      <ColorField
                        key={key}
                        label={label}
                        value={appearance.editor[key]}
                        onChange={(hex) => setEditor(key, hex)}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-preview">
                  <EditorPreview appearance={appearance} />
                </div>
              </div>
            )}

            {pane === 'notes' && (
              <div className="settings-split">
                <div className="settings-controls">
                  <div className="settings-pane-actions">
                    <Button
                      intent="secondary"
                      onClick={() => set({ notes: DEFAULT_APPEARANCE.notes })}
                    >
                      Reset section
                    </Button>
                  </div>
                  <div className="settings-color-grid">
                    {NOTES_FIELDS.map(({ key, label }) => (
                      <ColorField
                        key={key}
                        label={label}
                        value={appearance.notes[key]}
                        onChange={(hex) => setNotes(key, hex)}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-preview">
                  <NotesPreview appearance={appearance} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="settings-view-footer">
        <Button
          intent="secondary"
          onClick={() =>
            pane === 'agents' ? onAgentsChange(DEFAULT_AGENTS) : onChange(DEFAULT_APPEARANCE)
          }
        >
          {pane === 'agents' ? 'Reset agents to defaults' : 'Reset appearance to defaults'}
        </Button>
        <div className="wt-footer-spacer" />
        <Button intent="primary" onClick={onClose}>
          Done
        </Button>
      </footer>
    </div>
  )
}
