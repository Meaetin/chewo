import { Dot } from './Dot'

interface RowProps {
  selected?: boolean
  /**
   * Selection colour. 'accent' (default) = emerald "you are here" for the
   * focused item (session/terminal); 'neutral' = grey highlight for an
   * expanded container (project/Home) so the two don't read the same.
   */
  tone?: 'accent' | 'neutral'
  /** Adds a --live-bg tint and a cyan live Dot in the leading slot. */
  live?: boolean
  leading?: React.ReactNode
  /** Hover/focus-revealed actions (IconButtons). */
  trailing?: React.ReactNode
  density?: 'default' | 'compact'
  onClick?: () => void
  className?: string
  children: React.ReactNode
}

/**
 * One list-row treatment: same hover + selection on every surface
 * (design/04 §2.7). A div, not a button, so trailing IconButtons can nest.
 */
export function Row({
  selected = false,
  tone = 'accent',
  live = false,
  leading,
  trailing,
  density = 'default',
  onClick,
  className,
  children
}: RowProps): React.JSX.Element {
  const classes = [
    'row',
    selected ? (tone === 'neutral' ? 'row--selected-neutral' : 'row--selected') : '',
    live ? 'row--live' : '',
    density === 'compact' ? 'row--compact' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const interactive = Boolean(onClick)

  return (
    <div
      className={classes}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      {(live || leading) && (
        <span className="row__leading">
          {live && <Dot tone="live" />}
          {leading}
        </span>
      )}
      <span className="row__body">{children}</span>
      {trailing && <span className="row__trailing">{trailing}</span>}
    </div>
  )
}
