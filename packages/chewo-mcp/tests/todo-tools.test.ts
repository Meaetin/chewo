import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server'
import { addCard, loadBoard, setTodosRoot } from '../../../src/shared/todos-store'
import { resolveScope, writeScopeIndex, type TodoScope } from '../../../src/shared/todo-scopes'
import { projectScopeDir } from '../../../src/shared/todos'

const PIE = '/Users/test/Desktop/Projects/pie'
const PIE_DIR = projectScopeDir('pie', PIE)

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bridge-todos-'))
  setTodosRoot(tmp)
  writeScopeIndex([{ dir: PIE_DIR, name: 'pie', path: PIE }])
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const SCOPES: TodoScope[] = [
  { dir: 'general', name: 'General' },
  { dir: PIE_DIR, name: 'pie', path: PIE }
]

describe('scope resolution', () => {
  test('no scope + a cwd inside a project → that project board', () => {
    expect(resolveScope(SCOPES, undefined, join(PIE, 'src/deep'))?.dir).toBe(PIE_DIR)
  })

  test('no scope + an unrelated cwd → General', () => {
    expect(resolveScope(SCOPES, undefined, '/tmp/elsewhere')?.dir).toBe('general')
  })

  test('a sibling directory sharing a name prefix is not a match', () => {
    expect(resolveScope(SCOPES, undefined, `${PIE}-old`)?.dir).toBe('general')
  })

  test('by name, by directory, by path, and loosely by name', () => {
    expect(resolveScope(SCOPES, 'pie', undefined)?.dir).toBe(PIE_DIR)
    expect(resolveScope(SCOPES, PIE_DIR, undefined)?.dir).toBe(PIE_DIR)
    expect(resolveScope(SCOPES, PIE, undefined)?.dir).toBe(PIE_DIR)
    expect(resolveScope(SCOPES, 'General', undefined)?.dir).toBe('general')
  })

  test('an unknown name resolves to nothing rather than the wrong board', () => {
    expect(resolveScope(SCOPES, 'cake', PIE)).toBeNull()
  })
})

describe('todo tools over MCP', () => {
  async function connect(cwd?: string) {
    const server = buildServer({ agent: 'claude', bridgeRoot: join(tmp, 'bridge'), cwd })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
  }

  const textOf = (result: any): string => result.content[0].text
  const jsonOf = (result: any): any => JSON.parse(textOf(result))

  test('an agent files a todo into its own project board, then lists it', async () => {
    const client = await connect(join(PIE, 'src'))
    const added = jsonOf(
      await client.callTool({
        name: 'todo_add',
        arguments: { title: 'Fix the flaky crust test', text: 'fails ~1 in 5' }
      })
    )
    expect(added.scope).toBe('pie')
    expect(added.column).toBe('todo')

    // landed on disk, on the project board — not General
    const board = loadBoard(PIE_DIR)
    expect(board.cards[added.added.id].title).toBe('Fix the flaky crust test')
    expect(loadBoard('general').columns.todo).toHaveLength(0)

    const listed = jsonOf(await client.callTool({ name: 'todos_list', arguments: {} }))
    expect(listed.columns.todo[0]).toMatchObject({ id: added.added.id, text: 'fails ~1 in 5' })
  })

  test('explicit scope beats the cwd default', async () => {
    const client = await connect(PIE)
    const added = jsonOf(
      await client.callTool({
        name: 'todo_add',
        arguments: { title: 'Buy stamps', scope: 'General', status: 'blocked' }
      })
    )
    expect(added.scope).toBe('General')
    expect(loadBoard('general').columns.blocked).toHaveLength(1)
  })

  test('move, update, and delete round-trip against real card ids', async () => {
    const client = await connect(PIE)
    const id = Object.keys(addCard(PIE_DIR, 'Ship the pie').cards)[0]

    const moved = jsonOf(
      await client.callTool({ name: 'todo_move', arguments: { cardId: id, to: 'done' } })
    )
    expect(moved.to).toBe('done')
    expect(loadBoard(PIE_DIR).columns.done).toEqual([id])

    await client.callTool({
      name: 'todo_update',
      arguments: { cardId: id, text: 'shipped 2026-07-20' }
    })
    const updated = loadBoard(PIE_DIR).cards[id]
    expect(updated.title).toBe('Ship the pie') // omitted field kept
    expect(updated.text).toBe('shipped 2026-07-20')

    await client.callTool({ name: 'todo_delete', arguments: { cardId: id } })
    expect(loadBoard(PIE_DIR).cards[id]).toBeUndefined()
  })

  test('all: true reads every board at once', async () => {
    addCard('general', 'general card')
    addCard(PIE_DIR, 'pie card')
    const client = await connect()
    const boards = jsonOf(await client.callTool({ name: 'todos_list', arguments: { all: true } }))
    expect(boards.map((b: any) => b.scope).sort()).toEqual(['General', 'pie'])
  })

  test('unknown scope and unknown card id come back as usable errors', async () => {
    const client = await connect(PIE)
    const badScope = textOf(
      await client.callTool({ name: 'todo_add', arguments: { title: 'x', scope: 'cake' } })
    )
    expect(badScope).toContain('Unknown todo scope')
    expect(badScope).toContain('pie')

    const badCard = textOf(
      await client.callTool({ name: 'todo_move', arguments: { cardId: 'nope', to: 'done' } })
    )
    expect(badCard).toContain('No card nope')
    expect(badCard).toContain('todos_list')
  })

  test('without a scope index, General still works', async () => {
    rmSync(join(tmp, 'scopes.json'))
    const client = await connect(PIE)
    const added = jsonOf(await client.callTool({ name: 'todo_add', arguments: { title: 'orphan' } }))
    expect(added.scope).toBe('General')
  })
})
