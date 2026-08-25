import { describe, expect, test } from 'vitest'
import {
  livePaneBySession,
  unrepresentedLivePanes,
  type LiveSessionPane
} from '../src/renderer/src/codingWorkspace'

const pane = (patch: Partial<LiveSessionPane>): LiveSessionPane => ({
  paneId: 1,
  projectId: 'p1',
  source: 'claude',
  title: 'New session',
  pending: true,
  exited: false,
  ...patch
})

describe('coding workspace session projection', () => {
  test('shows pending and not-yet-scanned bound panes under their project', () => {
    const panes = [
      pane({ paneId: 1 }),
      pane({ paneId: 2, sessionId: 's2', pending: false }),
      pane({ paneId: 3, projectId: 'p2' })
    ]
    expect(unrepresentedLivePanes(panes, new Set(), 'p1').map((item) => item.paneId)).toEqual([
      2, 1
    ])
  })

  test('drops a live placeholder once its transcript is scanned', () => {
    const panes = [pane({ sessionId: 's1', pending: false })]
    expect(unrepresentedLivePanes(panes, new Set(['s1']), 'p1')).toEqual([])
    expect(livePaneBySession(panes, 's1')?.paneId).toBe(1)
  })
})
