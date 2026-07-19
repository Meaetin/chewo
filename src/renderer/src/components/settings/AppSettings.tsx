import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type EditorSyntaxColors,
  type NotesColors,
  type TerminalAnsiColors
} from '../../../../shared/appearance'
import { CURATED_ACCENTS, CURATED_BASES, matchPreset, type ThemePreset } from '../../../../shared/presets'
import { Button, IconButton } from '../ui'
import { ColorField } from './ColorField'
import { PresetGallery } from './PresetGallery'
import { AppPreview } from './AppPreview'
import { TerminalPreview } from './TerminalPreview'
import { EditorPreview } from './EditorPreview'
import { NotesPreview } from './NotesPreview'

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

type Tab = 'presets' | 'app' | 'terminal' | 'editor' | 'notes'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'presets', label: 'Presets' },
  { id: 'app', label: 'App' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor' },
  { id: 'notes', label: 'Notes' }
]

interface AppSettingsProps {
  appearance: AppearanceSettings
  /** Live-applies — every change re-themes the app immediately */
  onChange: (a: AppearanceSettings) => void
  onClose: () => void
}

/** Full-screen appearance settings: presets landing + per-category live previews. */
export function AppSettings({ appearance, onChange, onClose }: AppSettingsProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('presets')

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

  const applyPreset = (preset: ThemePreset): void => onChange(preset.appearance)

  return (
    <div className="settings-view">
      <header className="settings-view-header">
        <div className="settings-view-heading">
          <div className="settings-view-title">Settings</div>
          <div className="settings-view-subtitle">
            Appearance · changes apply immediately and save automatically
          </div>
        </div>
        <IconButton label="Close (Esc)" tooltipSide="bottom" onClick={onClose}>
          <X size={20} strokeWidth={1.75} />
        </IconButton>
      </header>

      <nav className="settings-view-tabs" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-view-tab ${tab === t.id ? 'settings-view-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'presets' && activePreset === null && (
              <span className="settings-view-tab-badge">Custom</span>
            )}
          </button>
        ))}
      </nav>

      <div className="settings-view-body">
        {tab === 'presets' && <PresetGallery selectedId={activePreset} onPick={applyPreset} />}

        {tab === 'app' && (
          <div className="settings-split">
            <div className="settings-controls">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">App colors</div>
                  <div className="settings-section-hint">
                    Every surface, border, text level and highlight derives from these four.
                  </div>
                </div>
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
                  Reset
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

        {tab === 'terminal' && (
          <div className="settings-split">
            <div className="settings-controls">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">Terminal</div>
                  <div className="settings-section-hint">
                    ANSI palette for every terminal. Background follows Base; cursor and selection
                    follow Accent.
                  </div>
                </div>
                <Button intent="secondary" onClick={() => set({ terminal: DEFAULT_APPEARANCE.terminal })}>
                  Reset
                </Button>
              </div>
              <div className="settings-color-grid">
                {TERMINAL_FIELDS.map(({ key, label }) => (
                  <ColorField
                    key={key}
                    label={label}
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

        {tab === 'editor' && (
          <div className="settings-split">
            <div className="settings-controls">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">Code &amp; notes editor</div>
                  <div className="settings-section-hint">
                    Syntax highlighting in the file editor and the notes editor (edit mode). The
                    rendered notes preview is themed in the Notes tab.
                  </div>
                </div>
                <Button intent="secondary" onClick={() => set({ editor: DEFAULT_APPEARANCE.editor })}>
                  Reset
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

        {tab === 'notes' && (
          <div className="settings-split">
            <div className="settings-controls">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">Notes</div>
                  <div className="settings-section-hint">
                    Markdown accents in the lesson preview. Surfaces and text follow Base; these
                    color headings, links, inline code and blockquotes.
                  </div>
                </div>
                <Button intent="secondary" onClick={() => set({ notes: DEFAULT_APPEARANCE.notes })}>
                  Reset
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

      <footer className="settings-view-footer">
        <Button intent="secondary" onClick={() => onChange(DEFAULT_APPEARANCE)}>
          Reset all to defaults
        </Button>
        <div className="wt-footer-spacer" />
        <Button intent="primary" onClick={onClose}>
          Done
        </Button>
      </footer>
    </div>
  )
}
