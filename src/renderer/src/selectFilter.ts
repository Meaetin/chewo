/**
 * Filtering for the searchable `Select` (src/renderer/src/components/Select.tsx).
 *
 * Split out so it can be tested without a DOM, the same way `fileTabs.ts`
 * holds the tab-reordering rule.
 */

export interface FilterableOption {
  value: string
  label: string
  detail?: string
}

/**
 * Case-insensitive substring match across the label, the detail, and the raw
 * value — a language should be reachable by either "Spanish" or "es-419",
 * whichever half the user happens to know. An empty query matches everything.
 */
export function filterOptions<T extends FilterableOption>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((option) =>
    [option.label, option.detail, option.value].some((field) =>
      field?.toLowerCase().includes(q)
    )
  )
}
