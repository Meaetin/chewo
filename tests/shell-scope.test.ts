import { describe, expect, test } from 'vitest'
import { ownedShells, visibleShells, type ShellPane } from '../src/renderer/src/shellScope'

const shell = (patch: Partial<ShellPane> & { paneId: number }): ShellPane => ({
  projectId: 'p1',
  ...patch
})

describe('visibleShells', () => {
  test('shows the focused session its own shells', () => {
    const shells = [shell({ paneId: 10, ownerPaneId: 1 }), shell({ paneId: 11, ownerPaneId: 2 })]
    expect(visibleShells(shells, 1, 'p1').map((s) => s.paneId)).toEqual([10])
  })

  test('hides another session’s shells rather than pooling them per project', () => {
    const shells = [shell({ paneId: 10, ownerPaneId: 2 })]
    expect(visibleShells(shells, 1, 'p1')).toEqual([])
  })

  test('keeps unowned project shells visible from every session', () => {
    const shells = [shell({ paneId: 10, ownerPaneId: 1 }), shell({ paneId: 11 })]
    expect(visibleShells(shells, 1, 'p1').map((s) => s.paneId)).toEqual([10, 11])
    expect(visibleShells(shells, 2, 'p1').map((s) => s.paneId)).toEqual([11])
  })

  test('an unowned shell belongs to its own project only', () => {
    const shells = [shell({ paneId: 10, projectId: 'p2' })]
    expect(visibleShells(shells, null, 'p1')).toEqual([])
    expect(visibleShells(shells, null, 'p2').map((s) => s.paneId)).toEqual([10])
  })

  test('with no session focused, only the project shells show', () => {
    const shells = [shell({ paneId: 10, ownerPaneId: 1 }), shell({ paneId: 11 })]
    expect(visibleShells(shells, null, 'p1').map((s) => s.paneId)).toEqual([11])
  })

  test('Home is a section like any other — null matches null, not everything', () => {
    const shells = [shell({ paneId: 10, projectId: null }), shell({ paneId: 11, projectId: 'p1' })]
    expect(visibleShells(shells, null, null).map((s) => s.paneId)).toEqual([10])
  })
})

describe('ownedShells', () => {
  test('names what closing a session has to take with it', () => {
    const shells = [
      shell({ paneId: 10, ownerPaneId: 1 }),
      shell({ paneId: 11, ownerPaneId: 2 }),
      shell({ paneId: 12 })
    ]
    expect(ownedShells(shells, 1).map((s) => s.paneId)).toEqual([10])
  })

  test('an unowned shell outlives every session', () => {
    expect(ownedShells([shell({ paneId: 12 })], 1)).toEqual([])
  })
})
