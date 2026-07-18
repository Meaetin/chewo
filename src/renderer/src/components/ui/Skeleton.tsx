interface SkeletonProps {
  /** Any CSS length (number → px). Defaults to full width. */
  width?: string | number
  /** Any CSS length (number → px). */
  height?: string | number
  radius?: string
  className?: string
}

/** Static loading block — no shimmer (design/05 §5). */
export function Skeleton({
  width,
  height,
  radius,
  className
}: SkeletonProps): React.JSX.Element {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius }}
    />
  )
}
