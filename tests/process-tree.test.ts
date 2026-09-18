import { describe, expect, it } from 'vitest'
import {
  collectDescendants,
  parseProcessTable,
  rootsWithDescendants
} from '../src/main/process-tree'

const rows = (pairs: [number, number][]): { pid: number; ppid: number }[] =>
  pairs.map(([pid, ppid]) => ({ pid, ppid }))

describe('collectDescendants', () => {
  it('finds the whole tree below a root', () => {
    // 100 (pane) -> 200 (claude) -> 300 (task shell) -> 400,401 (hogs)
    const table = rows([
      [1, 0],
      [100, 1],
      [200, 100],
      [300, 200],
      [400, 300],
      [401, 300]
    ])
    expect(collectDescendants(table, [100]).sort()).toEqual([200, 300, 400, 401])
  })

  it('orders children before their parent', () => {
    const table = rows([
      [100, 1],
      [200, 100],
      [300, 200]
    ])
    // Signalling 200 before 300 would let 300 reparent and escape the sweep.
    expect(collectDescendants(table, [100])).toEqual([300, 200])
  })

  it('excludes the roots themselves — the caller kills those', () => {
    const table = rows([
      [100, 1],
      [200, 100]
    ])
    expect(collectDescendants(table, [100])).not.toContain(100)
  })

  it('ignores unrelated branches of the tree', () => {
    const table = rows([
      [100, 1],
      [200, 100],
      [500, 1],
      [600, 500]
    ])
    expect(collectDescendants(table, [100])).toEqual([200])
  })

  it('accepts several roots at once, without double-counting a shared child', () => {
    const table = rows([
      [100, 1],
      [101, 1],
      [200, 100],
      [201, 101]
    ])
    expect(collectDescendants(table, [100, 101]).sort()).toEqual([200, 201])
  })

  it('terminates on a cycle rather than walking forever', () => {
    // A malformed table must not hang the quit path.
    const table = rows([
      [100, 1],
      [200, 100],
      [100, 200]
    ])
    expect(() => collectDescendants(table, [100])).not.toThrow()
  })

  it('never yields pid 1, whatever the table claims', () => {
    const table = rows([
      [100, 1],
      [1, 100]
    ])
    expect(collectDescendants(table, [100])).not.toContain(1)
  })

  it('returns nothing for a root with no children', () => {
    expect(collectDescendants(rows([[100, 1]]), [100])).toEqual([])
  })
})

describe('rootsWithDescendants', () => {
  it('reports a pane running a command, not one sitting at a prompt', () => {
    // 100 is an idle zsh; 101 is a zsh running a dev server (200).
    const table = rows([
      [100, 1],
      [101, 1],
      [200, 101]
    ])
    expect(rootsWithDescendants(table, [100, 101])).toEqual([101])
  })

  it('keeps the caller’s order, so an id maps back to its pane', () => {
    const table = rows([
      [100, 1],
      [101, 1],
      [200, 100],
      [201, 101]
    ])
    expect(rootsWithDescendants(table, [101, 100])).toEqual([101, 100])
  })

  it('a grandchild alone still counts — the child is the parent we see', () => {
    const table = rows([
      [100, 1],
      [200, 100],
      [300, 200]
    ])
    expect(rootsWithDescendants(table, [100])).toEqual([100])
  })

  it('a pid no longer in the table is not busy', () => {
    expect(rootsWithDescendants(rows([[100, 1]]), [999])).toEqual([])
  })

  it('never reports pid 1 or 0, whatever the table claims', () => {
    expect(rootsWithDescendants(rows([[100, 1]]), [1, 0])).toEqual([])
  })
})

describe('parseProcessTable', () => {
  it('reads the two-column ps output', () => {
    expect(parseProcessTable('  100     1\n  200   100\n')).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 }
    ])
  })

  it('skips blank and malformed lines', () => {
    expect(parseProcessTable('\n100 1\nnot a row\n  \n')).toEqual([{ pid: 100, ppid: 1 }])
  })
})
