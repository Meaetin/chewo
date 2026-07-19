import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoard, projectScopeDir, statusOf } from '../src/shared/todos'
import {
  addCard,
  clearDone,
  deleteCard,
  loadBoard,
  moveCard,
  readAsset,
  setTodosRoot,
  updateCard
} from '../src/main/todos'

const PNG_B64 = Buffer.from('not-really-a-png').toString('base64')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chewo-todos-'))
  setTodosRoot(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('projectScopeDir', () => {
  test('slug + stable hash from the path', () => {
    const a = projectScopeDir('My App!', '/Users/x/dev/my-app')
    expect(a).toMatch(/^p-my-app-[0-9a-f]{8}$/)
    expect(projectScopeDir('My App!', '/Users/x/dev/my-app')).toBe(a)
  })

  test('same name, different path → different scope', () => {
    expect(projectScopeDir('app', '/a')).not.toBe(projectScopeDir('app', '/b'))
  })
})

describe('board mutations', () => {
  test('addCard lands at the top of its column', () => {
    addCard('general', 'first')
    const board = addCard('general', 'second')
    const titles = board.columns.todo.map((id) => board.cards[id].title)
    expect(titles).toEqual(['second', 'first'])
  })

  test('addCard with only whitespace is a no-op', () => {
    const board = addCard('general', '   ')
    expect(Object.keys(board.cards)).toHaveLength(0)
  })

  test('moveCard inserts at the top — including same-column drops', () => {
    addCard('general', 'a')
    let board = addCard('general', 'b') // b above a
    const aId = board.columns.todo[1]
    board = moveCard('general', aId, 'in-progress')
    expect(board.columns['in-progress']).toEqual([aId])
    expect(statusOf(board, aId)).toBe('in-progress')

    // same-column drop resurfaces the card at the top
    const bId = board.columns.todo[0]
    addCard('general', 'c') // c above b
    board = moveCard('general', bId, 'todo')
    expect(board.columns.todo[0]).toBe(bId)
  })

  test('updateCard stages images and empty text drops the field', () => {
    let board = addCard('general', 'card')
    const id = board.columns.todo[0]
    board = updateCard({
      scopeDir: 'general',
      cardId: id,
      title: 'renamed',
      text: 'details',
      addImages: [PNG_B64],
      removeImages: []
    })
    const card = board.cards[id]
    expect(card.title).toBe('renamed')
    expect(card.text).toBe('details')
    expect(card.images).toHaveLength(1)
    expect(readAsset('general', card.images![0])).toContain('base64,')

    board = updateCard({
      scopeDir: 'general',
      cardId: id,
      title: 'renamed',
      text: '  ',
      addImages: [],
      removeImages: card.images!
    })
    expect(board.cards[id].text).toBeUndefined()
    expect(board.cards[id].images).toBeUndefined()
    expect(readdirSync(join(tmp, 'general', 'assets'))).toHaveLength(0)
  })

  test('deleteCard removes the card and its assets', () => {
    let board = addCard('general', 'doomed')
    const id = board.columns.todo[0]
    board = updateCard({
      scopeDir: 'general',
      cardId: id,
      title: 'doomed',
      text: '',
      addImages: [PNG_B64],
      removeImages: []
    })
    board = deleteCard('general', id)
    expect(board.cards[id]).toBeUndefined()
    expect(board.columns.todo).toEqual([])
    expect(readdirSync(join(tmp, 'general', 'assets'))).toHaveLength(0)
  })

  test('clearDone empties only the done column', () => {
    addCard('general', 'keep')
    let board = addCard('general', 'finish me', 'done')
    board = clearDone('general')
    expect(board.columns.done).toEqual([])
    expect(board.columns.todo).toHaveLength(1)
  })

  test('mutations persist — a fresh load sees them', () => {
    addCard('general', 'persisted')
    const board = loadBoard('general')
    expect(Object.values(board.cards)[0].title).toBe('persisted')
  })
})

describe('loadBoard resilience', () => {
  test('missing or corrupt board.json → empty board', () => {
    expect(loadBoard('general')).toEqual(emptyBoard())
    mkdirSync(join(tmp, 'general'), { recursive: true })
    writeFileSync(join(tmp, 'general', 'board.json'), '{not json')
    expect(loadBoard('general')).toEqual(emptyBoard())
  })

  test('hand-edited file: orphan column ids are dropped, missing columns restored', () => {
    mkdirSync(join(tmp, 'general'), { recursive: true })
    writeFileSync(
      join(tmp, 'general', 'board.json'),
      JSON.stringify({
        version: 1,
        columns: { todo: ['real', 'ghost'] },
        cards: { real: { id: 'real', title: 'x', createdAt: '', updatedAt: '' } }
      })
    )
    const board = loadBoard('general')
    expect(board.columns.todo).toEqual(['real'])
    expect(board.columns.blocked).toEqual([])
  })

  test('path-like scope names are rejected', () => {
    expect(() => loadBoard('../escape')).toThrow(/bad scope/)
    expect(existsSync(join(tmp, '..', 'escape'))).toBe(false)
  })

  test('asset reads reject non-asset filenames', () => {
    expect(readAsset('general', '../board.json')).toBeNull()
  })
})
