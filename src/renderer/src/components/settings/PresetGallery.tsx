import { Check } from 'lucide-react'
import { deriveSurfaces, deriveTextRamp } from '../../../../shared/appearance'
import { PRESETS, type ThemePreset } from '../../../../shared/presets'

/** One preset card — a mini swatch of the theme's own base/accent/syntax/ANSI */
function PresetCard({
  preset,
  selected,
  onPick
}: {
  preset: ThemePreset
  selected: boolean
  onPick: () => void
}): React.JSX.Element {
  const a = preset.appearance
  const bg = deriveSurfaces(a.base).surfaces[1]
  const panel = deriveSurfaces(a.base).surfaces[2]
  const fg = deriveTextRamp(a.base).primary

  return (
    <button
      type="button"
      className={`preset-card ${selected ? 'preset-card-active' : ''}`}
      onClick={onPick}
    >
      <div className="preset-card-swatch" style={{ background: bg, color: fg }}>
        <div className="preset-card-chips">
          <span style={{ background: a.accent }} />
          <span style={{ background: a.accentSecondary }} />
          <span style={{ background: a.accentTertiary }} />
        </div>
        <div className="preset-card-code" style={{ background: panel }}>
          <span style={{ color: a.editor.keyword }}>const</span>{' '}
          <span style={{ color: a.editor.function }}>run</span>
          <span style={{ color: a.editor.punctuation }}>()</span>{' '}
          <span style={{ color: a.editor.string }}>"ok"</span>
        </div>
        <div className="preset-card-term">
          <span style={{ color: a.accent }}>~</span>{' '}
          <span style={{ color: a.terminal.green }}>+add</span>{' '}
          <span style={{ color: a.terminal.red }}>-del</span>
        </div>
        {selected && (
          <span className="preset-card-check">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="preset-card-meta">
        <div className="preset-card-name">{preset.name}</div>
        <div className="preset-card-desc">{preset.description}</div>
      </div>
    </button>
  )
}

/** Gallery of preset themes. `selectedId` is null when settings match no preset. */
export function PresetGallery({
  selectedId,
  onPick
}: {
  selectedId: string | null
  onPick: (preset: ThemePreset) => void
}): React.JSX.Element {
  return (
    <div className="preset-gallery-wrap">
      <div className="preset-gallery-intro">
        Pick a starting theme, then fine-tune it in the App, Terminal and Editor tabs.
        {selectedId === null && <span className="preset-gallery-custom"> · Custom (edited)</span>}
      </div>
      <div className="preset-gallery">
        {PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            onPick={() => onPick(preset)}
          />
        ))}
      </div>
    </div>
  )
}
