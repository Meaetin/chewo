import { useEffect, useState } from 'react'
import { normalizeHex } from '../../../../shared/appearance'

interface ColorFieldProps {
  label: string
  hint?: string
  value: string
  onChange: (hex: string) => void
  /** Optional quick-pick row (curated palette) shown above the swatch + hex */
  swatches?: string[]
}

/**
 * One editable color: an optional curated quick-pick row, then a native
 * color-picker swatch + hex input. Hex commits on blur/Enter; the swatch and
 * quick-picks apply immediately.
 */
export function ColorField({
  label,
  hint,
  value,
  onChange,
  swatches
}: ColorFieldProps): React.JSX.Element {
  const [text, setText] = useState(value)
  // Follow outside changes (swatch picks, presets, section resets)
  useEffect(() => setText(value), [value])

  const commit = (): void => {
    const hex = normalizeHex(text)
    if (hex && hex !== value) onChange(hex)
    else setText(value)
  }

  const current = normalizeHex(value)

  return (
    <div className="settings-color-field">
      <div className="settings-color-row">
        <input
          type="color"
          className="settings-color-swatch"
          aria-label={`${label} color`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="settings-color-meta">
          <div className="settings-color-label">{label}</div>
          {hint && <div className="settings-color-hint">{hint}</div>}
        </div>
        <input
          className="settings-color-hex"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
      </div>
      {swatches && swatches.length > 0 && (
        <div className="settings-swatch-row">
          {swatches.map((hex) => (
            <button
              key={hex}
              type="button"
              className={`settings-swatch ${normalizeHex(hex) === current ? 'settings-swatch-active' : ''}`}
              style={{ background: hex }}
              title={hex}
              aria-label={`Use ${hex}`}
              onClick={() => onChange(hex)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
