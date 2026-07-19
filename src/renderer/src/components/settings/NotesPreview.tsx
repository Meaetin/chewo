import type { AppearanceSettings } from '../../../../shared/appearance'

/**
 * Mock lesson preview painted with the notes markdown accents. Surfaces/borders
 * come from the app tokens (so it tracks Base); the heading/link/code/quote
 * colors are the live notes settings, mirroring the real .notes-md-preview.
 */
export function NotesPreview({ appearance }: { appearance: AppearanceSettings }): React.JSX.Element {
  const n = appearance.notes
  return (
    <div className="notes-preview">
      <div className="notes-preview-doc message-markdown">
        <h1 style={{ color: n.heading }}>Derivatives — chain rule</h1>
        <p>
          The derivative of a composite is the product of derivatives. See{' '}
          <a style={{ color: n.link }}>the proof</a> for the full argument, or run{' '}
          <code style={{ color: n.code }}>d/dx</code> on a sample.
        </p>
        <blockquote style={{ color: n.quote, borderLeftColor: n.quote }}>
          If <code style={{ color: n.code }}>f(x) = g(h(x))</code>, then f′ = g′(h(x))·h′(x).
        </blockquote>
        <h2 style={{ color: n.heading }}>Worked example</h2>
        <ul>
          <li>
            Let <code style={{ color: n.code }}>u = h(x)</code>
          </li>
          <li>
            Differentiate the outer <a style={{ color: n.link }}>g(u)</a>
          </li>
        </ul>
      </div>
    </div>
  )
}
