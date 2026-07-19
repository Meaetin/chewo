import { Terminal } from 'lucide-react'

/**
 * Live mini-app frame. App-level colors live-apply to :root, so everything here
 * reads straight from the token system and updates as you edit. Shows what the
 * base + accents drive — and, greyed with a "fixed" tag, what a theme does not
 * touch (status + source badges).
 */
export function AppPreview(): React.JSX.Element {
  return (
    <div className="app-preview">
      <div className="app-preview-frame">
        <div className="app-preview-sidebar">
          <div className="app-preview-row app-preview-row-accent">
            <span className="app-preview-dot app-preview-dot-live" />
            claude · main
          </div>
          <div className="app-preview-row app-preview-row-project">◇ web-app</div>
          <div className="app-preview-row">codex · api</div>
          <div className="app-preview-row app-preview-muted">docs</div>
        </div>
        <div className="app-preview-main">
          <div className="app-preview-card">
            <Terminal size={13} strokeWidth={1.75} className="app-preview-card-glyph" />
            <div className="app-preview-text-primary">Primary text</div>
            <div className="app-preview-text-secondary">Secondary text sits a step back</div>
            <div className="app-preview-text-tertiary">Tertiary — hints and metadata</div>
          </div>
          <div className="app-preview-buttons">
            <button className="app-preview-btn app-preview-btn-primary">Run</button>
            <button className="app-preview-btn app-preview-btn-secondary">Cancel</button>
          </div>
        </div>
      </div>
      <div className="app-preview-fixed">
        <span className="app-preview-fixed-label">Not themed:</span>
        <span className="app-preview-badge app-preview-badge-claude">Claude</span>
        <span className="app-preview-badge app-preview-badge-codex">Codex</span>
        <span className="app-preview-chip app-preview-chip-danger">danger</span>
        <span className="app-preview-chip app-preview-chip-warning">warning</span>
      </div>
    </div>
  )
}
