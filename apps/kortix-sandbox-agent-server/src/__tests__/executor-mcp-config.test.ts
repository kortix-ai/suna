/**
 * The daemon assembles opencode's inline config (OPENCODE_CONFIG_CONTENT) at
 * spawn from three independent contributors. These tests pin that contract:
 * - the Kortix Executor MCP server (when token + api url present),
 * - the Kortix LLM gateway provider (when gateway env present),
 * - a Slack `question`-deny permission (when it's a Slack session),
 * - merges onto (never clobbers) any pre-existing inline config,
 * - returns undefined when no contributor applies.
 */
import { describe, expect, test } from 'bun:test'

import { buildOpencodeConfigContent } from '../opencode'

const ENV = { KORTIX_EXECUTOR_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' }

describe('buildOpencodeConfigContent', () => {
  test('registers the executor MCP server with resolved credentials', () => {
    const raw = buildOpencodeConfigContent(ENV)
    expect(raw).toBeDefined()
    const config = JSON.parse(raw!)
    const server = config.mcp['kortix-executor']
    expect(server).toMatchObject({
      type: 'local',
      enabled: true,
      environment: { KORTIX_EXECUTOR_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' },
    })
    expect(server.command).toEqual(['kortix', 'executor', 'mcp'])
  })

  test('returns undefined when the gateway is unreachable', () => {
    expect(buildOpencodeConfigContent({})).toBeUndefined()
    expect(buildOpencodeConfigContent({ KORTIX_EXECUTOR_TOKEN: 'tok-123' })).toBeUndefined()
    expect(buildOpencodeConfigContent({ KORTIX_API_URL: 'https://api.kortix.test/v1' })).toBeUndefined()
  })

  test('merges onto pre-existing inline config without clobbering it', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['echo'], enabled: true } },
    })
    const config = JSON.parse(buildOpencodeConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: existing })!)
    expect(config.theme).toBe('dark')
    expect(config.mcp.other).toBeDefined()
    expect(config.mcp['kortix-executor']).toBeDefined()
  })

  test('survives malformed pre-existing inline config', () => {
    const config = JSON.parse(buildOpencodeConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: 'not json{' })!)
    expect(config.mcp['kortix-executor']).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — Kortix LLM gateway provider', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_LLM_API_KEY: 'kyolo_abc123',
  }

  test('registers the kortix provider when gateway env present', () => {
    const config = JSON.parse(buildOpencodeConfigContent(GATEWAY_ENV)!)
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

  test('sets default model to kortix/* when none in pre-existing config', () => {
    const config = JSON.parse(buildOpencodeConfigContent(GATEWAY_ENV)!)
    expect(config.model).toMatch(/^kortix\//)
  })

  test('preserves user-set default model from pre-existing config', () => {
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' })
    const config = JSON.parse(
      buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing })!,
    )
    expect(config.model).toBe('anthropic/claude-sonnet-4.6')
  })

  test('coexists with the executor MCP server in one config', () => {
    const config = JSON.parse(buildOpencodeConfigContent({ ...ENV, ...GATEWAY_ENV })!)
    expect(config.mcp['kortix-executor']).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })

  test('returns undefined when neither executor nor gateway env is present', () => {
    expect(buildOpencodeConfigContent({})).toBeUndefined()
  })

  test('returns config with provider only (no mcp) when executor env missing', () => {
    const config = JSON.parse(buildOpencodeConfigContent(GATEWAY_ENV)!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('declares reasoning + tool_call + attachment on capable Kortix models', () => {
    const config = JSON.parse(buildOpencodeConfigContent(GATEWAY_ENV)!)
    const models = config.provider.kortix.models
    expect(models['anthropic/claude-opus-4.8'].reasoning).toBe(true)
    expect(models['anthropic/claude-sonnet-4.6'].reasoning).toBe(true)
    expect(models['deepseek/deepseek-v4-flash'].reasoning).toBe(true)
    expect(models['anthropic/claude-opus-4.8'].tool_call).toBe(true)
    expect(models['anthropic/claude-opus-4.8'].attachment).toBe(true)
    expect(models['x-ai/grok-4.3'].tool_call).toBe(true)
    expect(models['minimax/minimax-m3'].tool_call).toBe(true)
  })

  test('merges provider onto pre-existing inline provider block', () => {
    const existing = JSON.stringify({
      provider: { anthropic: { options: { timeout: 600000 } } },
    })
    const config = JSON.parse(
      buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing })!,
    )
    expect(config.provider.anthropic).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — Slack sessions deny the question tool', () => {
  test('denies `question` when the session carries Slack thread/channel env', () => {
    const config = JSON.parse(buildOpencodeConfigContent({ ...ENV, SLACK_THREAD_TS: '1700000000.0001' })!)
    expect(config.permission.question).toBe('deny')
    // SLACK_CHANNEL_ID alone is enough too.
    const byChannel = JSON.parse(buildOpencodeConfigContent({ ...ENV, SLACK_CHANNEL_ID: 'C123' })!)
    expect(byChannel.permission.question).toBe('deny')
  })

  test('builds the config for a Slack session even with no executor/gateway env', () => {
    const raw = buildOpencodeConfigContent({ SLACK_CHANNEL_ID: 'C123' })
    expect(raw).toBeDefined()
    expect(JSON.parse(raw!).permission.question).toBe('deny')
  })

  test('does NOT touch permissions for a non-Slack (web) session — tool stays native', () => {
    const config = JSON.parse(buildOpencodeConfigContent(ENV)!)
    expect(config.permission).toBeUndefined()
  })

  test('merges the deny onto a pre-existing permission block', () => {
    const existing = JSON.stringify({ permission: { bash: 'ask' } })
    const config = JSON.parse(
      buildOpencodeConfigContent({ ...ENV, SLACK_THREAD_TS: '1700000000.0001', OPENCODE_CONFIG_CONTENT: existing })!,
    )
    expect(config.permission.bash).toBe('ask')
    expect(config.permission.question).toBe('deny')
  })
})
