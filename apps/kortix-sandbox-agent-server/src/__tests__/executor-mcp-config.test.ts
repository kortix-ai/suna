import { afterEach, describe, expect, test } from 'bun:test'

import { buildExecutorMcpConfigContent, buildOpencodeConfigContent } from '../opencode'

const ENV = { KORTIX_EXECUTOR_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' }

const GATEWAY_CATALOG = {
  'anthropic/claude-opus-4.8': { name: 'Claude Opus 4.8', reasoning: true, tool_call: true, attachment: true, temperature: true },
  'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6', reasoning: true, tool_call: true, attachment: true },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', reasoning: true, tool_call: true },
  'x-ai/grok-4.3': { name: 'Grok 4.3', tool_call: true },
  'minimax/minimax-m3': { name: 'Minimax M3', tool_call: true },
}

const realFetch = globalThis.fetch

function stubGatewayModels(catalog: Record<string, unknown>) {
  globalThis.fetch = (async (input: string) => {
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ models: catalog }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('buildOpencodeConfigContent — optional executor MCP server', () => {
  test('does not register executor MCP by default; CLI is the primary Executor path', async () => {
    expect(await buildOpencodeConfigContent(ENV)).toBeUndefined()
  })

  test('registers the executor MCP server only when explicitly enabled', async () => {
    const raw = await buildOpencodeConfigContent({ ...ENV, KORTIX_EXECUTOR_MCP_ENABLED: '1' })
    expect(raw).toBeDefined()
    const config = JSON.parse(raw!)
    const server = config.mcp['kortix-executor']
    expect(server).toMatchObject({
      type: 'local',
      enabled: true,
      environment: {
        KORTIX_EXECUTOR_TOKEN: 'tok-123',
        KORTIX_API_URL: 'https://api.kortix.test/v1',
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
    })
    expect(server.command).toEqual(['/usr/local/bin/kortix', 'executor', 'mcp'])
  })

  test('returns undefined when no contributor applies', async () => {
    expect(await buildOpencodeConfigContent({})).toBeUndefined()
    expect(await buildOpencodeConfigContent({ KORTIX_EXECUTOR_TOKEN: 'tok-123' })).toBeUndefined()
    expect(await buildOpencodeConfigContent({ KORTIX_API_URL: 'https://api.kortix.test/v1' })).toBeUndefined()
    expect(await buildOpencodeConfigContent({ ...ENV, KORTIX_EXECUTOR_MCP_ENABLED: '0' })).toBeUndefined()
  })

  test('merges onto pre-existing inline config without clobbering it', async () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['echo'], enabled: true } },
    })
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_EXECUTOR_MCP_ENABLED: '1',
      OPENCODE_CONFIG_CONTENT: existing,
    }))!)
    expect(config.theme).toBe('dark')
    expect(config.mcp.other).toBeDefined()
    expect(config.mcp['kortix-executor']).toBeDefined()
  })

  test('survives malformed pre-existing inline config', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_EXECUTOR_MCP_ENABLED: '1',
      OPENCODE_CONFIG_CONTENT: 'not json{',
    }))!)
    expect(config.mcp['kortix-executor']).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — Kortix LLM gateway provider', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_LLM_API_KEY: 'kyolo_abc123',
  }

  test('registers the kortix provider when gateway env present', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
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

  test('populates the provider models from the gateway /models fetch', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    const models = config.provider.kortix.models
    expect(models['anthropic/claude-opus-4.8'].reasoning).toBe(true)
    expect(models['anthropic/claude-sonnet-4.6'].reasoning).toBe(true)
    expect(models['deepseek/deepseek-v4-flash'].reasoning).toBe(true)
    expect(models['x-ai/grok-4.3'].tool_call).toBe(true)
    expect(models['minimax/minimax-m3'].tool_call).toBe(true)
  })

  test('falls back to a minimal catalog when the gateway /models fetch fails', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    const models = config.provider.kortix.models
    expect(Object.keys(models).length).toBeGreaterThan(0)
    expect(models['claude-sonnet-4.6']).toBeDefined()
  }, 20_000) // full backoff (~15.5s) before the minimal-catalog fallback

  test('sets default model to kortix/* when none in pre-existing config', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.model).toMatch(/^kortix\//)
  })

  test('preserves user-set default model from pre-existing config', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.model).toBe('anthropic/claude-sonnet-4.6')
  })

  test('does not include executor MCP alongside the provider unless explicitly enabled', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, ...GATEWAY_ENV }))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('can include the optional executor MCP alongside the provider', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...ENV,
      ...GATEWAY_ENV,
      KORTIX_EXECUTOR_MCP_ENABLED: 'true',
    }))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp['kortix-executor']).toBeDefined()
  })

  test('returns config with provider only (no mcp) when executor env missing', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('merges provider onto pre-existing inline provider block', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
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
    KORTIX_LLM_API_KEY: 'kyolo_abc123',
  }

  test('allows only kortix when the gateway is active', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('a leaked native key (e.g. GITHUB_TOKEN) cannot open its native provider', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, GITHUB_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x' }))!,
    )
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('does not enable codex/openai subscription providers while gateway is active', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
    const authJson = JSON.stringify({ openai: { type: 'oauth', access: 'x' }, opencode: { key: 'y' } })
    const config = JSON.parse((await buildOpencodeConfigContent({ ...GATEWAY_ENV, CODEX_AUTH_JSON: authJson }))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('ignores malformed auth.json and still keeps the explicit allowlist', async () => {
    stubGatewayModels(GATEWAY_CATALOG)
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

  test('builds the config for a Slack session even with no executor/gateway env', async () => {
    const raw = await buildOpencodeConfigContent({ SLACK_CHANNEL_ID: 'C123' })
    expect(raw).toBeDefined()
    expect(JSON.parse(raw!).permission.question).toBe('deny')
  })

  test('does NOT touch permissions for a non-Slack (web) session — tool stays native', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, KORTIX_EXECUTOR_MCP_ENABLED: '1' }))!)
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
