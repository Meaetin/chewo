import { describe, expect, test } from 'vitest'
import { normalizeLayout } from '../src/renderer/src/layoutState'

describe('workspace layout', () => {
  test('clamps persisted dimensions to safe bounds', () => {
    expect(
      normalizeLayout(
        { sidebarWidth: 20, toolsWidth: 2000, explorerWidth: 900, explorerCollapsed: true },
        1000
      )
    ).toEqual({
      sidebarWidth: 240,
      toolsWidth: 720,
      explorerWidth: 420,
      explorerCollapsed: true
    })
  })

  test('fills missing settings with defaults', () => {
    expect(normalizeLayout(undefined, 1200)).toEqual({
      sidebarWidth: 300,
      toolsWidth: 620,
      explorerWidth: 240,
      explorerCollapsed: false
    })
  })
})
