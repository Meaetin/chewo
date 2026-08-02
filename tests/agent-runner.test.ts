import { describe, expect, test } from 'vitest'
import { chatCommand, normalizeChatEvent } from '../src/main/agent-runner'
import { AGENTS, EFFORT_LEVELS, normalizeAgents } from '../src/shared/agents'
import { parseCodexModels } from '../src/main/agent-models'

/**
 * Both CLIs' event streams are undocumented internal formats (KNOWN-ISSUES #1).
 * These fixtures are real lines captured from each CLI — if one changes shape,
 * the normalizer stops emitting and these fail rather than the chat silently
 * going blank.
 */

describe('normalizeChatEvent — claude stream-json', () => {
  test('init carries the resume session id', () => {
    expect(
      normalizeChatEvent('claude', { type: 'system', subtype: 'init', session_id: 'abc-123' })
    ).toEqual([{ type: 'chat_session', sessionId: 'abc-123' }])
  })

  test('assistant text is a delta to append', () => {
    expect(
      normalizeChatEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hel' }] }
      })
    ).toEqual([{ type: 'chat_text', text: 'Hel', delta: true }])
  })

  test('tool_use becomes a status, and mixed blocks keep their order', () => {
    expect(
      normalizeChatEvent('claude', {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Grep' },
            { type: 'text', text: 'found it' }
          ]
        }
      })
    ).toEqual([
      { type: 'chat_tool', name: 'Grep' },
      { type: 'chat_text', text: 'found it', delta: true }
    ])
  })

  test('result reports success and failure', () => {
    expect(normalizeChatEvent('claude', { type: 'result', is_error: false })).toEqual([
      { type: 'chat_result', isError: false }
    ])
    expect(normalizeChatEvent('claude', { type: 'result', is_error: true })).toEqual([
      { type: 'chat_result', isError: true }
    ])
  })

  test('unknown line types are dropped, never fatal', () => {
    expect(normalizeChatEvent('claude', { type: 'some_future_event' })).toEqual([])
  })
})

describe('normalizeChatEvent — codex JSONL', () => {
  test('thread.started carries the resume id', () => {
    expect(normalizeChatEvent('codex', { type: 'thread.started', thread_id: 'th-1' })).toEqual([
      { type: 'chat_session', sessionId: 'th-1' }
    ])
  })

  test('a completed agent_message is a whole bubble, not a delta', () => {
    expect(
      normalizeChatEvent('codex', {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'hello' }
      })
    ).toEqual([{ type: 'chat_text', text: 'hello', delta: false }])
  })

  test('an agent_message only emits once it completes', () => {
    expect(
      normalizeChatEvent('codex', { type: 'item.started', item: { type: 'agent_message' } })
    ).toEqual([])
  })

  test('a started tool item becomes a status; its completion does not repeat it', () => {
    expect(
      normalizeChatEvent('codex', { type: 'item.started', item: { type: 'command_execution' } })
    ).toEqual([{ type: 'chat_tool', name: 'shell' }])
    expect(
      normalizeChatEvent('codex', { type: 'item.completed', item: { type: 'command_execution' } })
    ).toEqual([])
  })

  test('turn.completed ends the turn; turn.failed surfaces the message', () => {
    expect(normalizeChatEvent('codex', { type: 'turn.completed', usage: {} })).toEqual([
      { type: 'chat_result', isError: false }
    ])
    expect(
      normalizeChatEvent('codex', { type: 'turn.failed', error: { message: 'quota exhausted' } })
    ).toEqual([{ type: 'chat_error', message: 'quota exhausted' }])
  })

  test('unknown item types are dropped, never fatal', () => {
    expect(
      normalizeChatEvent('codex', { type: 'item.started', item: { type: 'some_future_item' } })
    ).toEqual([])
  })
})

describe('chatCommand', () => {
  test('claude denies scope-breaking tools and resumes by session id', () => {
    const fresh = chatCommand({ choice: { agent: 'claude' }, cwd: '/n', message: 'q' })
    expect(fresh).toContain('--output-format stream-json')
    expect(fresh).toContain('--disallowedTools "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch"')
    expect(fresh).not.toContain('--resume')
    expect(
      chatCommand({ choice: { agent: 'claude' }, cwd: '/n', message: 'q', resumeSessionId: 'u-1' })
    ).toContain('--resume u-1')
  })

  test('codex runs read-only and resumes through the exec subcommand', () => {
    const fresh = chatCommand({ choice: { agent: 'codex' }, cwd: '/n', message: 'q' })
    expect(fresh).toContain('codex exec --json')
    expect(fresh).toContain('-s read-only')
    // The notes root is not a git repo — codex refuses to start without this
    expect(fresh).toContain('--skip-git-repo-check')
    expect(
      chatCommand({ choice: { agent: 'codex' }, cwd: '/n', message: 'q', resumeSessionId: 'th-1' })
    ).toContain('codex exec resume th-1')
  })

  test('effort maps to each CLI spelling, and is omitted when unset', () => {
    expect(chatCommand({ choice: { agent: 'claude', effort: 'high' }, cwd: '/n', message: 'q' }))
      .toContain("--effort 'high'")
    expect(chatCommand({ choice: { agent: 'codex', effort: 'high' }, cwd: '/n', message: 'q' }))
      .toContain("-c model_reasoning_effort='high'")
    expect(chatCommand({ choice: { agent: 'claude' }, cwd: '/n', message: 'q' })).not.toContain(
      '--effort'
    )
  })

  test('codex passes no model unless one is chosen, so config.toml wins', () => {
    expect(chatCommand({ choice: { agent: 'codex' }, cwd: '/n', message: 'q' })).not.toContain(' -m ')
    expect(
      chatCommand({ choice: { agent: 'codex', model: 'gpt-5.5' }, cwd: '/n', message: 'q' })
    ).toContain("-m 'gpt-5.5'")
  })

  test('a chosen model overrides the registry default', () => {
    const cmd = chatCommand({ choice: { agent: 'claude', model: 'opus' }, cwd: '/n', message: 'q' })
    expect(cmd).toContain("--model 'opus'")
    expect(cmd).not.toContain('sonnet')
  })

  test('model and effort are shell-quoted — catalog slugs are not our literals', () => {
    const cmd = chatCommand({
      choice: { agent: 'codex', model: "x'; rm -rf /" },
      cwd: '/n',
      message: 'q'
    })
    // The payload survives verbatim but stays *inside* the quotes, so zsh
    // reads it as one literal argument rather than a second command. The
    // closing quote must come after it, not before.
    expect(cmd).toContain(String.raw`-m 'x'\''; rm -rf /'`)
    expect(cmd).not.toMatch(/rm -rf \/(?!')/)
  })
})

describe('normalizeAgents', () => {
  test('fills every task when the settings file predates the feature', () => {
    const out = normalizeAgents(undefined)
    expect(out).toEqual({
      notesStructure: { agent: 'claude' },
      notesChat: { agent: 'claude' },
      todoVoice: { agent: 'claude' },
      gitText: { agent: 'claude' }
    })
  })

  test('keeps valid choices and repairs unknown ones', () => {
    const out = normalizeAgents({
      notesChat: { agent: 'codex', effort: 'high' },
      // @ts-expect-error — an agent removed in a later version
      todoVoice: { agent: 'gemini' }
    })
    expect(out.notesChat).toEqual({ agent: 'codex', effort: 'high' })
    expect(out.todoVoice).toEqual({ agent: 'claude' })
    expect(out.notesStructure).toEqual({ agent: 'claude' })
  })

  test('keeps the model and effort of an agent that survived', () => {
    const out = normalizeAgents({
      notesStructure: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' }
    })
    expect(out.notesStructure).toEqual({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' })
  })

  test('drops model and effort when the agent had to be repaired', () => {
    // They name a model/level on the *other* CLI — carrying them forward would
    // fail at spawn time rather than silently doing the right thing.
    const out = normalizeAgents({
      // @ts-expect-error — an agent removed in a later version
      todoVoice: { agent: 'gemini', model: 'gemini-3-pro', effort: 'high' }
    })
    expect(out.todoVoice).toEqual({ agent: 'claude' })
  })

  test('drops empty-string model and effort rather than passing empty flags', () => {
    const out = normalizeAgents({ notesChat: { agent: 'claude', model: '', effort: '' } })
    expect(out.notesChat).toEqual({ agent: 'claude' })
  })
})

describe('agent registry', () => {
  test('every agent declares the traits the runner branches on', () => {
    for (const def of Object.values(AGENTS)) {
      expect(def.bin).toBeTruthy()
      expect(typeof def.streamsDeltas).toBe('boolean')
      expect(typeof def.strictSchema).toBe('boolean')
      expect(typeof def.discoverable).toBe('boolean')
      // A non-discoverable agent has no runtime source for its list, so its
      // static one is the only thing standing between the user and an empty picker.
      if (!def.discoverable) expect(def.models.length).toBeGreaterThan(0)
    }
  })

  test('claude offers aliases, not pinned ids — they track the latest model', () => {
    for (const m of AGENTS.claude.models) expect(m.id).not.toMatch(/\d/)
  })
})

describe('parseCodexModels', () => {
  // Captured from `codex debug models` (codex-cli 0.144.5)
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        visibility: 'list',
        priority: 1,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }]
      },
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        visibility: 'list',
        priority: 7,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
      },
      { slug: 'internal-thing', display_name: 'Internal', visibility: 'hidden', priority: 0 }
    ]
  })

  test('keeps listed models, ordered by the catalog priority', () => {
    expect(parseCodexModels(catalog).map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
  })

  test('drops anything the catalog does not mark visible', () => {
    expect(parseCodexModels(catalog).some((m) => m.id === 'internal-thing')).toBe(false)
  })

  test('carries per-model effort levels — they differ between models', () => {
    const [sol, gpt55] = parseCodexModels(catalog)
    expect(sol.efforts).toEqual(['low', 'max', 'ultra'])
    expect(gpt55.efforts).toEqual(['low', 'high'])
  })

  test('falls back to the standard ladder when a model declares none', () => {
    const out = parseCodexModels(JSON.stringify({ models: [{ slug: 'x', visibility: 'list' }] }))
    expect(out[0].efforts).toEqual(EFFORT_LEVELS)
  })

  test('unparseable output yields no models rather than throwing', () => {
    expect(parseCodexModels('zsh: command not found: codex')).toEqual([])
    expect(parseCodexModels('{}')).toEqual([])
  })
})
