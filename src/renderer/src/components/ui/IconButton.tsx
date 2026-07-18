import { Tooltip } from './Tooltip'

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — feeds the tooltip and the accessible name. No bare icons (design/04 §2.5). */
  label: string
  /** 28×28 default → 24×24 for dense sidebar rails. */
  dense?: boolean
  /** Selected/active glyph turns --accent. */
  active?: boolean
  tooltipSide?: 'top' | 'bottom'
}

/** Square transparent icon action; always tooltipped. */
export function IconButton({
  label,
  dense = false,
  active = false,
  tooltipSide = 'top',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  const classes = [
    'icon-btn',
    dense ? 'icon-btn--dense' : '',
    active ? 'icon-btn--active' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Tooltip label={label} side={tooltipSide}>
      <button type={type} className={classes} aria-label={label} {...rest}>
        {children}
      </button>
    </Tooltip>
  )
}
