import { DEFAULT_LAYOUT, type LayoutSettings } from '../../shared/appearance'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 480
export const TOOLS_MIN = 380
export const EXPLORER_MIN = 180
export const EXPLORER_MAX = 420
export const SESSION_MIN = 360

export const clampSize = (size: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(size), min), Math.max(min, max))

export function normalizeLayout(
  value: Partial<LayoutSettings> | undefined,
  availableWidth = Number.POSITIVE_INFINITY
): LayoutSettings {
  const toolsMax = Number.isFinite(availableWidth)
    ? Math.max(TOOLS_MIN, Math.floor(availableWidth * 0.72))
    : Number.MAX_SAFE_INTEGER
  return {
    sidebarWidth: clampSize(value?.sidebarWidth ?? DEFAULT_LAYOUT.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
    toolsWidth: clampSize(value?.toolsWidth ?? DEFAULT_LAYOUT.toolsWidth, TOOLS_MIN, toolsMax),
    explorerWidth: clampSize(
      value?.explorerWidth ?? DEFAULT_LAYOUT.explorerWidth,
      EXPLORER_MIN,
      EXPLORER_MAX
    ),
    explorerCollapsed: value?.explorerCollapsed ?? DEFAULT_LAYOUT.explorerCollapsed
  }
}
