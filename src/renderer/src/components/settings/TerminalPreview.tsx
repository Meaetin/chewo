import {
  deriveSurfaces,
  deriveTextRamp,
  type AppearanceSettings,
  type TerminalAnsiColors
} from '../../../../shared/appearance'

const NORMAL_ROW: Array<{ key: keyof TerminalAnsiColors; label: string }> = [
  { key: 'black', label: 'blk' },
  { key: 'red', label: 'red' },
  { key: 'green', label: 'grn' },
  { key: 'yellow', label: 'yel' },
  { key: 'blue', label: 'blu' },
  { key: 'magenta', label: 'mag' },
  { key: 'cyan', label: 'cyn' },
  { key: 'white', label: 'wht' }
]

const BRIGHT_ROW: Array<{ key: keyof TerminalAnsiColors; label: string }> = [
  { key: 'brightBlack', label: 'blk' },
  { key: 'brightRed', label: 'red' },
  { key: 'brightGreen', label: 'grn' },
  { key: 'brightYellow', label: 'yel' },
  { key: 'brightBlue', label: 'blu' },
  { key: 'brightMagenta', label: 'mag' },
  { key: 'brightCyan', label: 'cyn' },
  { key: 'brightWhite', label: 'wht' }
]

/**
 * Mock terminal painted with the live ANSI palette + a base-derived canvas —
 * the same derivation the real xterm theme uses (makeTerminalTheme). Updates as
 * the ANSI fields, the accent, or the base change.
 */
export function TerminalPreview({ appearance }: { appearance: AppearanceSettings }): React.JSX.Element {
  const t = appearance.terminal
  const bg = deriveSurfaces(appearance.base).surfaces[1]
  const fg = deriveTextRamp(appearance.base).primary

  return (
    <div className="term-preview">
      <div className="term-preview-screen" style={{ background: bg, color: fg }}>
        <div className="term-preview-line">
          <span style={{ color: appearance.accent }}>~/web-app</span>{' '}
          <span style={{ color: t.green }}>git:(</span>
          <span style={{ color: t.red }}>main</span>
          <span style={{ color: t.green }}>)</span> $ ls
        </div>
        <div className="term-preview-line">
          <span style={{ color: t.blue }}>src</span>{'  '}
          <span style={{ color: t.blue }}>node_modules</span>{'  '}
          <span style={{ color: t.green }}>build.sh</span>{'  '}
          README.md
        </div>
        <div className="term-preview-line">$ git status</div>
        <div className="term-preview-line">
          <span style={{ color: t.green }}>+ 12 additions</span>{'  '}
          <span style={{ color: t.red }}>- 3 deletions</span>
        </div>
        <div className="term-preview-line">
          <span style={{ color: t.yellow }}>warning:</span>{' '}
          <span style={{ color: t.magenta }}>2 files</span> changed,{' '}
          <span style={{ color: t.cyan }}>see diff</span>
        </div>
        <div className="term-preview-line">
          <span style={{ color: t.red }}>error:</span> build failed{' '}
          <span style={{ color: appearance.accent }}>▊</span>
        </div>
        {/* Bright variants in use: brightBlack = the ubiquitous "grey" for
            metadata; bold output often renders as bright too. */}
        <div className="term-preview-line">
          <span style={{ color: t.brightBlack }}>a1b2c3d</span>{' '}
          <span style={{ color: t.brightGreen, fontWeight: 700 }}>PASS</span>{' '}
          <span style={{ color: t.brightWhite, fontWeight: 700 }}>build</span>{' '}
          <span style={{ color: t.brightBlack }}>2.3s ago</span>
        </div>
      </div>

      <div className="term-preview-palette">
        <div className="term-preview-palette-label">Normal</div>
        <div className="term-preview-palette-row">
          {NORMAL_ROW.map(({ key, label }) => (
            <div key={key} className="term-preview-chip" title={`${key} — ${t[key]}`}>
              <span className="term-preview-chip-swatch" style={{ background: t[key] }} />
              <span className="term-preview-chip-label">{label}</span>
            </div>
          ))}
        </div>
        <div className="term-preview-palette-label">
          Bright <span className="term-preview-palette-note">· bold text &amp; emphasis</span>
        </div>
        <div className="term-preview-palette-row">
          {BRIGHT_ROW.map(({ key, label }) => (
            <div key={key} className="term-preview-chip" title={`${key} — ${t[key]}`}>
              <span className="term-preview-chip-swatch" style={{ background: t[key] }} />
              <span className="term-preview-chip-label">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
