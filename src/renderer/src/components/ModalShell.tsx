import { useEffect } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './ui'

interface ModalShellProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Blocked while work is in flight — closing mid-command would strand the UI */
  busy?: boolean
  /** Wider dialog for reading surfaces (e.g. the memory viewer). */
  size?: 'default' | 'wide'
  onClose: () => void
  children: React.ReactNode
  /** Omit for a footerless reading modal. */
  footer?: React.ReactNode
}

/** The one modal: header + scrollable body + optional footer, Esc/backdrop to close. */
export function ModalShell({
  title,
  subtitle,
  busy = false,
  size = 'default',
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
      <div
        className={`wt-modal ${size === 'wide' ? 'wt-modal--wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wt-modal-header">
          <div className="wt-modal-heading">
            <div className="wt-modal-title">{title}</div>
            {subtitle && <div className="wt-modal-subtitle">{subtitle}</div>}
          </div>
          <IconButton label="Close (Esc)" tooltipSide="bottom" disabled={busy} onClick={onClose}>
            <X size={20} strokeWidth={1.75} />
          </IconButton>
        </header>
        <div className="wt-modal-body">{children}</div>
        {footer && <footer className="wt-modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}
