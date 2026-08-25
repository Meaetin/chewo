import type { ReactNode } from 'react'
import type { PaneSource } from '../App'
import { Badge, Dot } from './ui'

interface SessionHeaderProps {
  leading?: ReactNode
  source?: PaneSource
  title: string
  live?: boolean
  checkout?: string
  checkoutTitle?: string
  actions?: ReactNode
}

/** Focused-session facts. Session switching belongs exclusively to the sidebar. */
export function SessionHeader({
  leading,
  source,
  title,
  live,
  checkout,
  checkoutTitle,
  actions
}: SessionHeaderProps): React.JSX.Element {
  return (
    <header className="session-header">
      {leading}
      {live && <Dot tone="live" className="session-header-live" />}
      {source && <Badge source={source} />}
      <span className="session-header-title" title={title}>
        {title}
      </span>
      {checkout && (
        <span className="session-header-checkout" title={checkoutTitle ?? checkout}>
          {checkout}
        </span>
      )}
      <span className="session-header-spacer" />
      {actions && <span className="session-header-actions">{actions}</span>}
    </header>
  )
}
