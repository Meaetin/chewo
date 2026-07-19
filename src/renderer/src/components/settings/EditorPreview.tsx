import {
  deriveSurfaces,
  deriveTextRamp,
  type AppearanceSettings
} from '../../../../shared/appearance'

/**
 * Mock code snippet painted with the live syntax palette on a base-derived
 * canvas — the same roles makeEditorTheme maps. Each token below is tagged with
 * the editor color it exercises so the preview covers all 13.
 */
export function EditorPreview({ appearance }: { appearance: AppearanceSettings }): React.JSX.Element {
  const c = appearance.editor
  const bg = deriveSurfaces(appearance.base).surfaces[1]
  const text = deriveTextRamp(appearance.base)
  const gutter = text.tertiary

  const Line = ({ n, children }: { n: number; children: React.ReactNode }): React.JSX.Element => (
    <div className="editor-preview-line">
      <span className="editor-preview-gutter" style={{ color: gutter }}>
        {n}
      </span>
      <span className="editor-preview-code">{children}</span>
    </div>
  )
  const S = ({ role, children }: { role: keyof typeof c; children: React.ReactNode }): React.JSX.Element => (
    <span style={{ color: c[role] }}>{children}</span>
  )
  const P = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <span style={{ color: c.punctuation }}>{children}</span>
  )

  return (
    <div className="editor-preview" style={{ background: bg, color: text.primary }}>
      <Line n={1}>
        <S role="comment">{'// derive a color ramp from one base'}</S>
      </Line>
      <Line n={2}>
        <S role="keyword">export function</S> <S role="function">ramp</S>
        <P>(</P>
        <S role="property">base</S>
        <P>:</P> <S role="type">string</S>
        <P>)</P> <P>{'{'}</P>
      </Line>
      <Line n={3}>
        {'  '}
        <S role="keyword">const</S> steps <P>=</P> <S role="number">6</S>
        <P>,</P> gap <P>=</P> <S role="number">1.6</S>
      </Line>
      <Line n={4}>
        {'  '}
        <S role="keyword">const</S> tag <P>=</P> <S role="tag">&lt;Swatch</S>{' '}
        <S role="attribute">hex</S>
        <P>=</P>
        <S role="string">"#3bbf8b"</S> <S role="tag">/&gt;</S>
      </Line>
      <Line n={5}>
        {'  '}
        <S role="keyword">return</S> <S role="function">build</S>
        <P>(</P>base<P>,</P> <S role="regexp">/\d+/g</S>
        <P>)</P>
        <P>.</P>
        <S role="property">map</S>
        <P>(</P>
        <S role="link">link</S>
        <P>)</P>
      </Line>
      <Line n={6}>
        <P>{'}'}</P>
      </Line>
    </div>
  )
}
