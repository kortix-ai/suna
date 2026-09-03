import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildOpencodeConfigContent } from '../opencode'

const ENV = { KORTIX_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' }

const GATEWAY_CATALOG = {
  'anthropic/claude-opus-4.8': { name: 'Claude Opus 4.8', provider: 'anthropic', reasoning: true, tool_call: true, attachment: true, temperature: true },
  'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6', reasoning: true, tool_call: true, attachment: true },
  'codex/gpt-5.6-sol': { name: 'GPT-5.6 Sol', reasoning: true, tool_call: true },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', reasoning: true, tool_call: true },
  'x-ai/grok-4.3': { name: 'Grok 4.3', tool_call: true },
  'minimax/minimax-m3': { name: 'Minimax M3', tool_call: true },
}

const realFetch = globalThis.fetch

const CATALOG_FILE = join(mkdtempSync(join(tmpdir(), 'kortix-mcp-catalog-')), 'catalog.json')

function stageGatewayCatalog(catalog: Record<string, unknown>) {
  writeFileSync(CATALOG_FILE, JSON.stringify({ models: catalog }))
  globalThis.fetch = (async (input: string) => {
    throw new Error(`boot config must not fetch; attempted ${String(input)}`)
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('buildOpencodeConfigContent — injected managed skills', () => {
  test('declares the injected skills dir via skills.paths', async () => {
    const dir = join(tmpdir(), `kortix-skills-test-${process.pid}`)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const content = await buildOpencodeConfigContent({}, { injectedSkillsDir: dir })
    const parsed = JSON.parse(content!)
    expect(parsed.skills.paths).toContain(dir)
  })

  test('merges with skills paths already declared by the compiled config', async () => {
    const dir = join(tmpdir(), `kortix-skills-test-${process.pid}`)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const content = await buildOpencodeConfigContent(
      { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ skills: { paths: ['/repo/skills'] } }) },
      { injectedSkillsDir: dir },
    )
    const parsed = JSON.parse(content!)
    expect(parsed.skills.paths).toEqual(['/repo/skills', dir])
  })

  test('a missing injected dir contributes nothing', async () => {
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent({}, { injectedSkillsDir: '/nonexistent-skills-dir' }))!,
    )
    expect(parsed.skills).toBeUndefined()
  })

  test('loads the generated secret capability guide without replacing project instructions', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kortix-secret-guide-')), 'capabilities.md')
    writeFileSync(file, '# Secret capabilities\n')
    const content = await buildOpencodeConfigContent(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['/workspace/AGENTS.md'] }) },
      { secretCapabilitiesInstructionPath: file },
    )
    expect(JSON.parse(content!).instructions).toEqual(['/workspace/AGENTS.md', file])
  })
})

describe('buildOpencodeConfigContent — optional connector MCP server', () => {
  test('does not register connector MCP by default; CLI is the primary Connector path', async () => {
    const parsed = JSON.parse((await buildOpencodeConfigContent(ENV))!)
    expect(parsed.mcp).toBeUndefined()
  })

  test('registers the connector MCP server only when explicitly enabled', async () => {
    const raw = await buildOpencodeConfigContent({ ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '1' })
    expect(raw).toBeDefined()
    const config = JSON.parse(raw!)
    const server = config.mcp['kortix-connectors']
    expect(server).toMatchObject({
      type: 'local',
      enabled: true,
      environment: {
        KORTIX_TOKEN: 'tok-123',
        KORTIX_API_URL: 'https://api.kortix.test/v1',
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
    })
    expect(server.command).toEqual(['/usr/local/bin/kortix', 'connectors', 'mcp'])
  })

  test('registers nothing session-specific when no contributor applies', async () => {
    for (const env of [
      {},
      { KORTIX_TOKEN: 'tok-123' },
      { KORTIX_API_URL: 'https://api.kortix.test/v1' },
      { ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '0' },
    ]) {
      const parsed = JSON.parse((await buildOpencodeConfigContent(env))!)
      expect(parsed.mcp).toBeUndefined()
      expect(parsed.provider).toBeUndefined()
    }
  })

  test('always disables OpenCode autoupdate — the daemon owns the binary', async () => {
    // A human running `opencode` in the Session terminal triggered OpenCode's
    // own upgrade (plain `pnpm add -g`, no postinstall) on two Essentia boxes
    // on 2026-08-25, leaving a 479-byte launcher stub and a dangling
    // /opt/kortix/opencode.current. The next OpenCode restart would have booted
    // the stub. Every composed config now pins autoupdate off, and a base
    // config cannot turn it back on.
    for (const env of [{}, ENV, { ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '1' }]) {
      expect(JSON.parse((await buildOpencodeConfigContent(env))!).autoupdate).toBe(false)
    }
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: true }) }))!,
    )
    expect(parsed.autoupdate).toBe(false)
  })

  test('merges onto pre-existing inline config without clobbering it', async () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['echo'], enabled: true } },
    })
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      OPENCODE_CONFIG_CONTENT: existing,
    }))!)
    expect(config.theme).toBe('dark')
    expect(config.mcp.other).toBeDefined()
    expect(config.mcp['kortix-connectors']).toBeDefined()
  })

  test('survives malformed pre-existing inline config', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      OPENCODE_CONFIG_CONTENT: 'not json{',
    }))!)
    expect(config.mcp['kortix-connectors']).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — Kortix LLM gateway provider', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('registers the kortix provider when gateway env present', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.provider.kortix).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Kortix',
      options: {
        baseURL: 'https://api.kortix.test/v1/llm',
        apiKey: 'kyolo_abc123',
      },
    })
    expect(Object.keys(config.provider.kortix.models).length).toBeGreaterThan(0)
  })

  test('populates the provider models from the baked catalog file', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    const models = config.provider.kortix.models
    expect(models['anthropic/claude-opus-4.8'].reasoning).toBe(true)
    expect(models['anthropic/claude-sonnet-4.6'].reasoning).toBe(true)
    expect(models['deepseek/deepseek-v4-flash'].reasoning).toBe(true)
    expect(models['x-ai/grok-4.3'].tool_call).toBe(true)
    expect(models['minimax/minimax-m3'].tool_call).toBe(true)
    // `provider` is picker metadata from the Kortix catalog, not part of an
    // OpenCode custom-provider model definition. OpenCode 1.1.25+ treats that
    // field as a nested provider override and rejects string values at startup.
    expect(models['anthropic/claude-opus-4.8'].provider).toBeUndefined()
  })

  test('falls back to a minimal catalog immediately when no catalog file exists', async () => {
    globalThis.fetch = (async (input: string) => {
      throw new Error(`boot config must not fetch; attempted ${String(input)}`)
    }) as unknown as typeof fetch
    const started = Date.now()
    const config = JSON.parse(
      (await buildOpencodeConfigContent({
        ...GATEWAY_ENV,
        KORTIX_LLM_CATALOG_FILE: join(tmpdir(), 'kortix-absent-catalog.json'),
      }))!,
    )
    const models = config.provider.kortix.models
    expect(Object.keys(models).length).toBeGreaterThan(0)
    expect(models['glm-5.3-flash']).toBeDefined()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('uses the resolved session model as the OpenCode default', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...GATEWAY_ENV,
      KORTIX_OPENCODE_MODEL: 'codex/gpt-5.6-sol',
    }))!)
    expect(config.model).toBe('kortix/codex/gpt-5.6-sol')
    expect(config.small_model).toBe('kortix/codex/gpt-5.6-sol')
  })

  test('uses an available gateway model for legacy sessions without a resolved model', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.model).toBe('kortix/anthropic/claude-opus-4.8')
    expect(config.small_model).toBe('kortix/anthropic/claude-opus-4.8')
  })

  test('routes a user-set default model through the Kortix provider', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.model).toBe('kortix/anthropic/claude-sonnet-4.6')
  })

  test('does not include connector MCP alongside the provider unless explicitly enabled', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, ...GATEWAY_ENV }))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('can include the optional connector MCP alongside the provider', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      ...GATEWAY_ENV,
      KORTIX_CONNECTORS_MCP_ENABLED: 'true',
    }))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp['kortix-connectors']).toBeDefined()
  })

  test('returns config with provider only (no mcp) when connector env missing', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('merges provider onto pre-existing inline provider block', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const existing = JSON.stringify({
      provider: { anthropic: { options: { timeout: 600000 } } },
    })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.provider.anthropic).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — gateway provider allowlist', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('allows only kortix when the gateway is active', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('a leaked native key (e.g. GITHUB_TOKEN) cannot open its native provider', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, GITHUB_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x' }))!,
    )
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('does not enable codex/openai subscription providers while gateway is active', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const authJson = JSON.stringify({ openai: { type: 'oauth', access: 'x' }, opencode: { key: 'y' } })
    const config = JSON.parse((await buildOpencodeConfigContent({ ...GATEWAY_ENV, CODEX_AUTH_JSON: authJson }))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('ignores malformed auth.json and still keeps the explicit allowlist', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_AUTH_JSON: 'not json{' }))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('does NOT set an allowlist when there is no gateway (subscription-only session stays native)', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, SLACK_CHANNEL_ID: 'C1' }))!)
    expect(config.enabled_providers).toBeUndefined()
  })
})

describe('buildOpencodeConfigContent — Slack sessions deny the question tool', () => {
  test('denies `question` when the session carries Slack thread/channel env', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, SLACK_THREAD_TS: '1700000000.0001' }))!)
    expect(config.permission.question).toBe('deny')
    const byChannel = JSON.parse((await buildOpencodeConfigContent({ ...ENV, SLACK_CHANNEL_ID: 'C123' }))!)
    expect(byChannel.permission.question).toBe('deny')
  })

  test('builds the config for a Slack session even with no connector/gateway env', async () => {
    const raw = await buildOpencodeConfigContent({ SLACK_CHANNEL_ID: 'C123' })
    expect(raw).toBeDefined()
    expect(JSON.parse(raw!).permission.question).toBe('deny')
  })

  test('does NOT touch permissions for a non-Slack (web) session — tool stays native', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '1' }))!)
    expect(config.permission).toBeUndefined()
  })

  test('merges the deny onto a pre-existing permission block', async () => {
    const existing = JSON.stringify({ permission: { bash: 'ask' } })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...ENV, SLACK_THREAD_TS: '1700000000.0001', OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.permission.bash).toBe('ask')
    expect(config.permission.question).toBe('deny')
  })
})

describe('buildOpencodeConfigContent — server-compiled v2 agent config (KORTIX_COMPILED_AGENT_CONFIG)', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }
  const COMPILED = JSON.stringify({
    model: 'anthropic/claude-sonnet-5',
    agent: {
      support: { mode: 'primary', model: 'anthropic/claude-sonnet-5', prompt: 'Triage support tickets.' },
    },
  })

  test('builds a config from the compiled agent config alone (no connector/gateway/Slack)', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ KORTIX_COMPILED_AGENT_CONFIG: COMPILED }))!)
    expect(config.model).toBe('anthropic/claude-sonnet-5')
    expect(config.agent.support).toEqual({
      mode: 'primary',
      model: 'anthropic/claude-sonnet-5',
      prompt: 'Triage support tickets.',
    })
  })

  test('a v1 project (no KORTIX_COMPILED_AGENT_CONFIG) is unaffected: no agent map with no other contributor', async () => {
    const parsed = JSON.parse((await buildOpencodeConfigContent({}))!)
    expect(parsed.agent).toBeUndefined()
    expect(parsed.model).toBeUndefined()
  })

  test('the gateway overlay normalizes compiled top-level and agent models', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, KORTIX_COMPILED_AGENT_CONFIG: COMPILED }))!,
    )
    expect(config.model).toBe('kortix/anthropic/claude-sonnet-5')
    expect(config.small_model).toMatch(/^kortix\//)
    expect(config.agent.support.model).toBe('kortix/anthropic/claude-sonnet-5')
  })

  test('the gateway overlay keeps the complete Codex wire model as the Kortix model id', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const compiled = JSON.stringify({
      model: 'codex/gpt-5.6-sol',
      agent: { mike: { mode: 'primary', model: 'codex/gpt-5.6-sol' } },
    })
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY_ENV,
      KORTIX_COMPILED_AGENT_CONFIG: compiled,
    })
    expect(raw).toBeDefined()
    if (!raw) throw new Error('expected gateway config')
    const config = JSON.parse(raw)
    expect(config.model).toBe('kortix/codex/gpt-5.6-sol')
    expect(config.agent.mike.model).toBe('kortix/codex/gpt-5.6-sol')
  })

  test('a Slack session still gets its question:deny overlay on top of the compiled agent map', async () => {
    const config = JSON.parse(
      (await buildOpencodeConfigContent({
        SLACK_CHANNEL_ID: 'C123',
        KORTIX_COMPILED_AGENT_CONFIG: COMPILED,
      }))!,
    )
    expect(config.agent.support).toBeDefined()
    expect(config.permission.question).toBe('deny')
  })

  test('connector MCP still layers onto the compiled base', async () => {
    const config = JSON.parse(
      (await buildOpencodeConfigContent({
        ...ENV,
        KORTIX_CONNECTORS_MCP_ENABLED: '1',
        KORTIX_COMPILED_AGENT_CONFIG: COMPILED,
      }))!,
    )
    expect(config.agent.support).toBeDefined()
    expect(config.mcp['kortix-connectors']).toBeDefined()
  })

  test('OPENCODE_CONFIG_CONTENT (repo config) wins over the compiled base on key collision', async () => {
    const existing = JSON.stringify({ model: 'repo/override-model' })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({
        KORTIX_COMPILED_AGENT_CONFIG: COMPILED,
        OPENCODE_CONFIG_CONTENT: existing,
      }))!,
    )
    expect(config.model).toBe('repo/override-model')
    expect(config.agent.support).toBeDefined()
  })

  test('malformed KORTIX_COMPILED_AGENT_CONFIG is ignored, not fatal', async () => {
    const config = await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      KORTIX_COMPILED_AGENT_CONFIG: 'not json{',
    })
    expect(config).toBeDefined()
    expect(JSON.parse(config!).agent).toBeUndefined()
    expect(JSON.parse(config!).mcp['kortix-connectors']).toBeDefined()
  })
})
