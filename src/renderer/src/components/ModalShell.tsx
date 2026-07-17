import { useEffect } from 'react'

interface ModalShellProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Blocked while work is in flight — closing mid-command would strand the UI */
  busy?: boolean
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}

/** Modal chrome: header + scrollable body + fixed footer, Esc/backdrop to close. */
export function ModalShell({
  title,
  subtitle,
  busy = false,
  onClose,
  children,
  footer
}: ModalShellProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="wt-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="wt-modal" onClick={(e) => e.stopPropagation()}>
        <header className="wt-modal-header">
          <div className="wt-modal-heading">
            <div className="wt-modal-title">{title}</div>
            {subtitle && <div className="wt-modal-subtitle">{subtitle}</div>}
          </div>
          <button className="wt-modal-close" title="Close (Esc)" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="wt-modal-body">{children}</div>
        <footer className="wt-modal-footer">{footer}</footer>
      </div>
    </div>
  )
}
