interface WorkingTextProps {
  /** Opacity pulse at --period-work; degrades to static when false or under reduced-motion. */
  pulse?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * The "machine speaking" loading register (design/05 §5): mono tertiary status
 * text with a single opacity pulse. Replaces the retired spinner. Not a ring.
 */
export function WorkingText({
  pulse = true,
  className,
  children
}: WorkingTextProps): React.JSX.Element {
  return (
    <span
      className={`working-text${pulse ? ' working-text--pulse' : ''}${
        className ? ` ${className}` : ''
      }`}
      aria-live="polite"
    >
      {children}
    </span>
  )
}
