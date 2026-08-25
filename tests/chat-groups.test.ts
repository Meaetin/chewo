import { describe, expect, it } from 'vitest'
import type { ChatItem, ToolCall, ToolStatus } from '../src/shared/agent-chat'
import { foldable, groupChatItems, groupSummary, MIN_GROUP } from '../src/shared/chat-groups'

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  toolUseId: 't',
  name: 'Bash',
  input: { command: 'ls' },
  status: 'ok',
  ...over
})

const tool = (id: string, over: Partial<ToolCall> = {}): ChatItem => ({
  kind: 'tool',
  id,
  call: { ...call(over), toolUseId: id }
})

const text = (id: string): ChatItem => ({ kind: 'text', id, text: 'hi', done: true })

const kinds = (items: ChatItem[]): string[] =>
  groupChatItems(items).map((r) => (r.kind === 'tools' ? `tools(${r.items.length})` : r.item.kind))

describe('groupChatItems', () => {
  it('folds a run of tool calls and leaves the prose around it alone', () => {
    expect(kinds([text('a'), tool('1'), tool('2'), tool('3'), text('b')])).toEqual([
      'text',
      'tools(3)',
      'text'
    ])
  })

  it('leaves a short run as its own chips', () => {
    expect(kinds([tool('1'), tool('2')])).toEqual(['tool', 'tool'])
    expect(MIN_GROUP).toBe(3)
  })

  it('keys a group off its first call, so it survives the next one arriving', () => {
    const rows = groupChatItems([tool('1'), tool('2'), tool('3')])
    const more = groupChatItems([tool('1'), tool('2'), tool('3'), tool('4')])
    expect(rows[0].id).toBe(more[0].id)
    expect(more[0].kind === 'tools' && more[0].items.length).toBe(4)
  })

  it('never swallows a call that is waiting on you', () => {
    // The approval splits the run, and both halves are too short to fold.
    expect(kinds([tool('1'), tool('2'), tool('3', { status: 'awaiting' }), tool('4')])).toEqual([
      'tool',
      'tool',
      'tool',
      'tool'
    ])
  })

  it('never swallows a diff, an image or a failure', () => {
    const patch = { filePath: '/a.ts', hunks: [] }
    expect(foldable(call({ patch }))).toBe(false)
    expect(foldable(call({ images: [{ mediaType: 'image/png', data: 'x' }] }))).toBe(false)
    for (const status of ['error', 'denied', 'awaiting'] as ToolStatus[])
      expect(foldable(call({ status }))).toBe(false)
    for (const status of ['ok', 'running', 'cancelled'] as ToolStatus[])
      expect(foldable(call({ status }))).toBe(true)
  })

  it('does not let an invisible plan call split a run in two', () => {
    // TaskUpdate renders as nothing — the plan panel draws it — so a run either
    // side of one is still one run.
    expect(
      kinds([tool('1'), tool('2'), tool('p', { name: 'TaskUpdate' }), tool('3')])
    ).toEqual(['tools(3)'])
  })

  it('keeps a plan call that is waiting on an approval', () => {
    expect(kinds([tool('p', { name: 'TaskUpdate', status: 'awaiting' })])).toEqual(['tool'])
  })
})

describe('groupSummary', () => {
  it('counts commands apart from everything else', () => {
    expect(groupSummary([call(), call(), call()])).toBe('Ran 3 commands')
    expect(groupSummary([call({ name: 'Read' }), call({ name: 'Grep' })])).toBe('Used 2 tools')
    expect(groupSummary([call(), call(), call({ name: 'Read' })])).toBe('Ran 2 commands, used a tool')
  })

  it('says "a tool" rather than "1 tool"', () => {
    expect(groupSummary([call({ name: 'Read' })])).toBe('Used a tool')
    expect(groupSummary([call()])).toBe('Ran a command')
  })
})
