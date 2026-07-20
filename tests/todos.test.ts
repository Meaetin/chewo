import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoard, projectScopeDir, statusOf } from '../src/shared/todos'
import {
  addCard,
  archiveDone,
  deleteArchived,
  deleteCard,
  deleteScope,
  emptyArchiveFile,
  loadArchive,
  restoreArchived,
  loadBoard,
  moveCard,
  readAsset,
  restoreAssets,
  restoreBoard,
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

  test('archiveDone empties only the done column', () => {
    addCard('general', 'keep')
    let board = addCard('general', 'finish me', 'done')
    board = archiveDone('general')
    expect(board.columns.done).toEqual([])
    expect(board.columns.todo).toHaveLength(1)
  })

  test('addCard with text (voice add) stores it trimmed', () => {
    const board = addCard('general', 'call dentist', 'todo', '  ask about invoice  ')
    const card = Object.values(board.cards)[0]
    expect(card.text).toBe('ask about invoice')
  })

  test('restoreBoard + restoreAssets undo a delete completely', () => {
    let board = addCard('general', 'victim')
    const id = board.columns.todo[0]
    board = updateCard({
      scopeDir: 'general',
      cardId: id,
      title: 'victim',
      text: '',
      addImages: [PNG_B64],
      removeImages: []
    })
    const imageName = board.cards[id].images![0]
    const snapshot = structuredClone(board)
    const dataUrl = readAsset('general', imageName)!
    const assetB64 = dataUrl.slice(dataUrl.indexOf(',') + 1)

    deleteCard('general', id)
    expect(readAsset('general', imageName)).toBeNull()

    restoreAssets('general', [{ name: imageName, base64: assetB64 }])
    const restored = restoreBoard('general', snapshot)
    expect(restored.cards[id].title).toBe('victim')
    expect(readAsset('general', imageName)).toContain('base64,')
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

describe('archive (T4)', () => {
  /** Stage a done card with an image and return its id. */
  const doneCardWithImage = (title: string): string => {
    const board = addCard('general', title, 'done')
    const id = board.columns.done[0]
    updateCard({
      scopeDir: 'general',
      cardId: id,
      title,
      text: 'notes',
      addImages: [PNG_B64],
      removeImages: []
    })
    return id
  }

  test('archiveDone moves done cards out of the board, keeping their assets', () => {
    const id = doneCardWithImage('finished')
    addCard('general', 'still going')

    const board = archiveDone('general')
    expect(board.columns.done).toEqual([])
    expect(board.cards[id]).toBeUndefined()
    expect(board.columns.todo).toHaveLength(1)

    const archive = loadArchive('general')
    expect(archive.cards).toHaveLength(1)
    expect(archive.cards[0]).toMatchObject({ id, title: 'finished', text: 'notes' })
    expect(archive.cards[0].archivedAt).toMatch(/^\d{4}-/)
    // the point of archiving over clearing: nothing was destroyed
    expect(readdirSync(join(tmp, 'general', 'assets'))).toHaveLength(1)
  })

  test('archiveDone on an empty done column is a no-op', () => {
    addCard('general', 'todo card')
    archiveDone('general')
    expect(loadArchive('general').cards).toHaveLength(0)
  })

  test('successive archives stack newest-first', () => {
    addCard('general', 'first', 'done')
    archiveDone('general')
    addCard('general', 'second', 'done')
    archiveDone('general')
    expect(loadArchive('general').cards.map((c) => c.title)).toEqual(['second', 'first'])
  })

  test('restore puts a card back at the top of Todo with its images intact', () => {
    const id = doneCardWithImage('resurrect me')
    archiveDone('general')
    addCard('general', 'already here')

    const board = restoreArchived('general', id)
    expect(board.columns.todo[0]).toBe(id)
    expect(board.cards[id].images).toHaveLength(1)
    expect(readAsset('general', board.cards[id].images![0])).toContain('base64,')
    expect(loadArchive('general').cards).toHaveLength(0)
    // archivedAt is archive-only bookkeeping — it must not ride back onto the board
    expect((board.cards[id] as unknown as Record<string, unknown>).archivedAt).toBeUndefined()
  })

  test('restoring an unknown id leaves the board alone', () => {
    addCard('general', 'untouched')
    const board = restoreArchived('general', 'nope')
    expect(board.columns.todo).toHaveLength(1)
  })

  test('deleting an archived card destroys it and its assets', () => {
    const id = doneCardWithImage('doomed')
    archiveDone('general')
    const archive = deleteArchived('general', id)
    expect(archive.cards).toHaveLength(0)
    expect(readdirSync(join(tmp, 'general', 'assets'))).toHaveLength(0)
  })

  test('emptying the archive clears every card and asset', () => {
    doneCardWithImage('one')
    archiveDone('general')
    doneCardWithImage('two')
    archiveDone('general')
    expect(loadArchive('general').cards).toHaveLength(2)

    expect(emptyArchiveFile('general').cards).toHaveLength(0)
    expect(loadArchive('general').cards).toHaveLength(0)
    expect(readdirSync(join(tmp, 'general', 'assets'))).toHaveLength(0)
  })

  test('a corrupt archive.json reads as empty rather than throwing', () => {
    addCard('general', 'x')
    writeFileSync(join(tmp, 'general', 'archive.json'), '{ not json')
    expect(loadArchive('general').cards).toEqual([])
  })
})

describe('deleteScope (T4 project-removal cleanup)', () => {
  test('removes the board, archive, and assets of one scope only', () => {
    const scope = projectScopeDir('pie', '/Users/x/pie')
    doneCard(scope)
    addCard('general', 'survivor')

    deleteScope(scope)
    expect(existsSync(join(tmp, scope))).toBe(false)
    expect(loadBoard('general').columns.todo).toHaveLength(1)
  })

  test('a scope that was never used deletes without error', () => {
    expect(() => deleteScope(projectScopeDir('ghost', '/nope'))).not.toThrow()
  })
})

/** A done card with an image, in an arbitrary scope. */
function doneCard(scope: string): void {
  const board = addCard(scope, 'done thing', 'done')
  updateCard({
    scopeDir: scope,
    cardId: board.columns.done[0],
    title: 'done thing',
    text: '',
    addImages: [PNG_B64],
    removeImages: []
  })
  archiveDone(scope)
}
