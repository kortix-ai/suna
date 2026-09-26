import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildOpencodeConfigContent } from '../harness/open-code/lifecycle'
import { CONNECTOR_PROXY_PLACEHOLDER_KEY, LLM_PROXY_PLACEHOLDER_KEY } from '../llm-proxy'

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

  test.each(['1', 'true'])('registers the connector MCP server only when explicitly enabled (%j)', async (enabled) => {
    const raw = await buildOpencodeConfigContent({ ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: enabled })
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
      // Enabled, but direct mode needs BOTH the token and the API URL.
      { KORTIX_TOKEN: 'tok-123', KORTIX_CONNECTORS_MCP_ENABLED: '1' },
      { KORTIX_API_URL: 'https://api.kortix.test/v1', KORTIX_CONNECTORS_MCP_ENABLED: '1' },
      { ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '0' },
    ]) {
      const parsed = JSON.parse((await buildOpencodeConfigContent(env))!)
      expect(parsed.mcp).toBeUndefined()
      expect(parsed.provider).toBeUndefined()
    }
  })

  test('always disables OpenCode autoupdate — the daemon owns the binary', async () => {
    // A human running `opencode` in the Session terminal triggered OpenCode's
    // own upgrade (plain `pnpm add -g`, no postinstall) on two SampleCo boxes
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

})

describe('buildOpencodeConfigContent — Slack sessions deny the question tool', () => {
  test.each([
    ['a Slack thread', { ...ENV, SLACK_THREAD_TS: '1700000000.0001' }],
    ['a Slack channel', { ...ENV, SLACK_CHANNEL_ID: 'C123' }],
    ['a Slack channel with no connector or gateway env', { SLACK_CHANNEL_ID: 'C123' }],
  ])('denies `question` for %s', async (_name, env) => {
    const config = JSON.parse((await buildOpencodeConfigContent(env))!)
    expect(config.permission.question).toBe('deny')
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

  // A Codex wire model keeps its whole ref as the Kortix model id.
  test.each(['anthropic/claude-sonnet-5', 'codex/gpt-5.6-sol'])(
    'the gateway overlay routes the compiled top-level and agent model %j through kortix/',
    async (model) => {
      stageGatewayCatalog(GATEWAY_CATALOG)
      const compiled = JSON.stringify({ model, agent: { support: { mode: 'primary', model } } })
      const config = JSON.parse(
        (await buildOpencodeConfigContent({ ...GATEWAY_ENV, KORTIX_COMPILED_AGENT_CONFIG: compiled }))!,
      )
      expect(config.model).toBe(`kortix/${model}`)
      expect(config.small_model).toMatch(/^kortix\//)
      expect(config.agent.support.model).toBe(`kortix/${model}`)
    },
  )

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

describe('buildOpencodeConfigContent — warm-fork proxy mode bakes no session credential', () => {
  // A warm seed has no session token. With the localhost proxies the composed
  // config is session-independent: the proxy injects the live token per request,
  // so a restored fork swaps credentials with no OpenCode restart.
  const PROXY_ENV = {
    KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
    KORTIX_CONNECTORS_PROXY_URL: 'http://127.0.0.1:4320',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
    KORTIX_TOKEN: 'real-session-token',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('the gateway provider points at the proxy with the placeholder key', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(PROXY_ENV))!)
    expect(config.provider.kortix.options.baseURL).toBe('http://127.0.0.1:4319')
    expect(config.provider.kortix.options.apiKey).toBe(LLM_PROXY_PLACEHOLDER_KEY)
    expect(JSON.stringify(config)).not.toContain('real-session-token')
    expect(config.mcp).toBeUndefined()
  })

  test('an enabled connector MCP points at the connector proxy with its placeholder', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...PROXY_ENV, KORTIX_CONNECTORS_MCP_ENABLED: '1' }))!,
    )
    const server = config.mcp['kortix-connectors']
    expect(server.command).toEqual(['/usr/local/bin/kortix', 'connectors', 'mcp'])
    expect(server.environment.KORTIX_API_URL).toBe('http://127.0.0.1:4320')
    expect(server.environment.KORTIX_TOKEN).toBe(CONNECTOR_PROXY_PLACEHOLDER_KEY)
    expect(JSON.stringify(config)).not.toContain('real-session-token')
  })
})
