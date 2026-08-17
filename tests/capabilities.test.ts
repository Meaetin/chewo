import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseCodexMcp,
  parseFrontmatter,
  scanCapabilities,
  splitList
} from '../src/shared/capabilities/scan'
import { parsePluginList, splitPluginId } from '../src/main/plugins'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'caps-test-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const write = (rel: string, content: string): void => {
  const path = join(tmp, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('parseFrontmatter', () => {
  test('simple values and quoted strings', () => {
    const fm = parseFrontmatter('---\nname: gsap-core\ndescription: "Core GSAP usage"\n---\n# Body')
    expect(fm.name).toBe('gsap-core')
    expect(fm.description).toBe('Core GSAP usage')
  })

  test('folded multiline description (>-)', () => {
    const fm = parseFrontmatter(
      '---\nname: visual-plan\ndescription: >-\n  Turn ordinary text plans into rich\n  interactive visual plans\n---\n'
    )
    expect(fm.description).toBe('Turn ordinary text plans into rich interactive visual plans')
  })

  test('no frontmatter → empty object', () => {
    expect(parseFrontmatter('# Just a heading')).toEqual({})
  })
})

describe('parseFrontmatter — block sequences', () => {
  test('collects `- item` lines under a key with no inline value', () => {
    const fm = parseFrontmatter(
      '---\nname: designer\nskills:\n  - figma-use\n  - "figma-design-to-code"\n---\n'
    )
    expect(splitList(fm.skills)).toEqual(['figma-use', 'figma-design-to-code'])
  })

  test('a dash after an inline value is not swallowed as a list item', () => {
    const fm = parseFrontmatter('---\ndescription: Reviews code - carefully\n---\n')
    expect(fm.description).toBe('Reviews code - carefully')
  })

  test('folded scalars still win over list mode', () => {
    const fm = parseFrontmatter('---\ndescription: >-\n  one\n  two\n---\n')
    expect(fm.description).toBe('one two')
  })
})

describe('splitList', () => {
  test('handles inline, bracketed, collapsed-block and empty spellings', () => {
    expect(splitList('Read, Grep, Glob')).toEqual(['Read', 'Grep', 'Glob'])
    expect(splitList('[Read, Grep]')).toEqual(['Read', 'Grep'])
    expect(splitList(undefined)).toEqual([])
    expect(splitList('')).toEqual([])
  })
})

describe('parsePluginList', () => {
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'figma@claude-plugins-official',
    version: '2.2.95',
    enabled: true,
    installPath: '/cache/claude-plugins-official/figma/2.2.95',
    ...over
  })

  test('splits id on the LAST @ so an @ in a name cannot reassign the halves', () => {
    expect(splitPluginId('figma@claude-plugins-official')).toEqual({
      plugin: 'figma',
      marketplace: 'claude-plugins-official'
    })
    expect(splitPluginId('scope@pkg@market')).toEqual({ plugin: 'scope@pkg', marketplace: 'market' })
    expect(splitPluginId('nomarket')).toBeNull()
    expect(splitPluginId('@market')).toBeNull()
    expect(splitPluginId('plugin@')).toBeNull()
  })

  test('keeps disabled rows but flags them; drops malformed ones', () => {
    const out = parsePluginList(
      JSON.stringify([
        row(),
        row({ id: 'codex@openai-codex', enabled: false }),
        row({ id: 'broken', installPath: '/x' }),
        row({ id: 'nopath@m', installPath: undefined }),
        'not-an-object'
      ])
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ plugin: 'figma', enabled: true })
    // installed but reaching no agent — the view greys it rather than hiding it
    expect(out[1]).toMatchObject({ plugin: 'codex', enabled: false })
  })

  test('bad JSON or a non-array degrades to empty rather than throwing', () => {
    expect(parsePluginList('not json')).toEqual([])
    expect(parsePluginList('{"plugins":[]}')).toEqual([])
  })
})

describe('parseCodexMcp', () => {
  test('extracts servers with command/args, quoted names, urls; ignores other sections', () => {
    const toml = [
      '[desktop]',
      'theme = "dark"',
      '[mcp_servers.context-bridge]',
      'command = "node"',
      'args = ["/path/dist/index.cjs", "--agent", "codex"]',
      '[mcp_servers."my server"]',
      'url = "https://example.com/mcp"',
      '[features]',
      'x = true'
    ].join('\n')
    const refs = parseCodexMcp(toml)
    expect(refs).toHaveLength(2)
    expect(refs[0].name).toBe('context-bridge')
    expect(refs[0].command).toBe('node /path/dist/index.cjs --agent codex')
    expect(refs[1].name).toBe('my server')
    expect(refs[1].command).toBe('https://example.com/mcp')
    // never leaks env
    expect(JSON.stringify(refs)).not.toContain('API_KEY')
  })
})

describe('scanCapabilities', () => {
  test('scans global + project scopes across both tools', () => {
    // Personal Claude
    write('claude-home/CLAUDE.md', '- global rule one\n')
    write('claude-home/skills/graphify/SKILL.md', '---\nname: graphify\ndescription: graphs\n---\n')
    write('claude-home/agents/reviewer.md', '---\nname: reviewer\ndescription: reviews PRs\n---\n')
    write('claude-config.json', JSON.stringify({ mcpServers: { bridge: { command: 'node', args: ['b.cjs'] } } }))
    // Personal Codex
    write('codex-home/AGENTS.md', '- codex global rule\n')
    write('codex-home/skills/visual-plan/SKILL.md', '---\nname: visual-plan\ndescription: plans\n---\n')
    write('codex-home/config.toml', '[mcp_servers.bridge]\ncommand = "node"\n')
    // Project with capabilities for both tools
    write('proj/CLAUDE.md', '# Project rules\n')
    write('proj/.claude/skills/gsap-core/SKILL.md', '---\nname: gsap-core\ndescription: tweens\n---\n')
    write('proj/.codex/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: deploys\n---\n')
    write('proj/.claude/agents/db-architect.md', '---\nname: db-architect\ndescription: schemas\n---\n')
    write('proj/.mcp.json', JSON.stringify({ mcpServers: { sentry: { url: 'https://mcp.sentry.dev' } } }))
    // Bare project
    mkdirSync(join(tmp, 'bare'), { recursive: true })

    const inventories = scanCapabilities(
      [
        { id: 'p1', name: 'proj', path: join(tmp, 'proj') },
        { id: 'p2', name: 'bare', path: join(tmp, 'bare') }
      ],
      {
        claudeHome: join(tmp, 'claude-home'),
        codexHome: join(tmp, 'codex-home'),
        claudeConfig: join(tmp, 'claude-config.json')
      }
    )

    expect(inventories).toHaveLength(4) // 2 global + 2 projects

    const [gClaude, gCodex, proj, bare] = inventories
    expect(gClaude.memory.claudeMd?.firstLine).toContain('global rule')
    expect(gClaude.skills.map((s) => s.name)).toEqual(['graphify'])
    expect(gClaude.agents[0].name).toBe('reviewer')
    expect(gClaude.mcp[0]).toMatchObject({ name: 'bridge', tool: 'claude', scope: 'user', command: 'node b.cjs' })

    expect(gCodex.memory.agentsMd?.firstLine).toContain('codex global')
    expect(gCodex.skills[0].tools).toEqual(['codex'])
    expect(gCodex.mcp[0].tool).toBe('codex')

    expect(proj.scope).toMatchObject({ kind: 'project', name: 'proj' })
    expect(proj.skills.map((s) => s.name).sort()).toEqual(['deploy', 'gsap-core'])
    expect(proj.skills.find((s) => s.name === 'gsap-core')?.tools).toEqual(['claude'])
    expect(proj.skills.find((s) => s.name === 'deploy')?.tools).toEqual(['codex'])
    expect(proj.agents[0].name).toBe('db-architect')
    expect(proj.mcp[0]).toMatchObject({ name: 'sentry', scope: 'project', command: 'https://mcp.sentry.dev' })
    expect(proj.memory.claudeMd).toBeDefined()
    expect(proj.memory.agentsMd).toBeUndefined()

    expect(bare.skills).toHaveLength(0)
    expect(bare.agents).toHaveLength(0)
    expect(bare.mcp).toHaveLength(0)
  })
})

describe('scanCapabilities — plugin-provided capabilities', () => {
  test('reads skills and agents out of an installed plugin, badged with its origin', () => {
    write(
      'cache/claude-plugins-official/figma/2.2.95/skills/figma-use/SKILL.md',
      '---\nname: figma-use\ndescription: Drive Figma\n---\n'
    )
    write(
      'cache/claude-plugins-official/figma/2.2.95/agents/designer.md',
      '---\nname: designer\ndescription: Designs UI\nmodel: opus\ntools: Read, Grep\nskills:\n  - figma-use\n---\nBody'
    )
    const inv = scanCapabilities([], {
      claudeHome: join(tmp, 'claude-home'),
      codexHome: join(tmp, 'codex-home'),
      claudeConfig: join(tmp, 'nope.json'),
      plugins: [
        {
          id: 'figma@claude-plugins-official',
          plugin: 'figma',
          marketplace: 'claude-plugins-official',
          version: '2.2.95',
          installPath: join(tmp, 'cache/claude-plugins-official/figma/2.2.95'),
          enabled: true
        }
      ]
    })
    const claude = inv.find((i) => i.scope.kind === 'global' && i.scope.tool === 'claude')!
    expect(claude.skills.map((s) => s.name)).toEqual(['figma-use'])
    expect(claude.skills[0].origin).toEqual({
      kind: 'plugin',
      plugin: 'figma',
      marketplace: 'claude-plugins-official',
      version: '2.2.95',
      enabled: true
    })
    const agent = claude.agents.find((a) => a.name === 'designer')!
    expect(agent.model).toBe('opus')
    expect(agent.tools).toEqual(['Read', 'Grep'])
    expect(agent.skills).toEqual(['figma-use'])
    expect(agent.origin.kind).toBe('plugin')
  })

  test('no plugins passed → same result as before, user dirs still win their origin', () => {
    write('claude-home/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews\n---\n')
    const inv = scanCapabilities([], {
      claudeHome: join(tmp, 'claude-home'),
      codexHome: join(tmp, 'codex-home'),
      claudeConfig: join(tmp, 'nope.json')
    })
    const claude = inv.find((i) => i.scope.kind === 'global' && i.scope.tool === 'claude')!
    expect(claude.agents).toHaveLength(1)
    expect(claude.agents[0].origin).toEqual({ kind: 'user' })
    // absent frontmatter stays absent — omitted `model` means "inherit"
    expect(claude.agents[0].model).toBeUndefined()
    expect(claude.agents[0].tools).toEqual([])
  })
})
