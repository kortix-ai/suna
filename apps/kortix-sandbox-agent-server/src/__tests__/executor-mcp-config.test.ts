/**
 * The daemon registers the Kortix Executor as a local MCP server by injecting
 * OPENCODE_CONFIG_CONTENT when opencode spawns. These tests pin that contract:
 * - registered only when the gateway is reachable (token + api url present),
 * - points at the in-image executor-mcp entry with the resolved credentials,
 * - merges onto (never clobbers) any pre-existing inline config.
 */
import { describe, expect, test } from 'bun:test'

import { buildExecutorMcpConfigContent } from '../opencode'

const ENV = { KORTIX_EXECUTOR_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' }

describe('buildExecutorMcpConfigContent', () => {
  test('registers the executor MCP server with resolved credentials', () => {
    const raw = buildExecutorMcpConfigContent(ENV)
    expect(raw).toBeDefined()
    const config = JSON.parse(raw!)
    const server = config.mcp['kortix-executor']
    expect(server).toMatchObject({
      type: 'local',
      enabled: true,
      environment: { KORTIX_EXECUTOR_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' },
    })
    expect(server.command[0]).toBe('bun')
    expect(server.command[1]).toContain('executor-mcp.ts')
  })

  test('returns undefined when the gateway is unreachable', () => {
    expect(buildExecutorMcpConfigContent({})).toBeUndefined()
    expect(buildExecutorMcpConfigContent({ KORTIX_EXECUTOR_TOKEN: 'tok-123' })).toBeUndefined()
    expect(buildExecutorMcpConfigContent({ KORTIX_API_URL: 'https://api.kortix.test/v1' })).toBeUndefined()
  })

  test('merges onto pre-existing inline config without clobbering it', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['echo'], enabled: true } },
    })
    const config = JSON.parse(buildExecutorMcpConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: existing })!)
    expect(config.theme).toBe('dark')
    expect(config.mcp.other).toBeDefined()
    expect(config.mcp['kortix-executor']).toBeDefined()
  })

  test('survives malformed pre-existing inline config', () => {
    const config = JSON.parse(buildExecutorMcpConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: 'not json{' })!)
    expect(config.mcp['kortix-executor']).toBeDefined()
  })
})

describe('buildExecutorMcpConfigContent — Kortix LLM gateway provider', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_LLM_API_KEY: 'kyolo_abc123',
  }

  test('registers the kortix provider when gateway env present', () => {
    const config = JSON.parse(buildExecutorMcpConfigContent(GATEWAY_ENV)!)
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
    const config = JSON.parse(buildExecutorMcpConfigContent(GATEWAY_ENV)!)
    expect(config.model).toMatch(/^kortix\//)
  })

  test('preserves user-set default model from pre-existing config', () => {
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' })
    const config = JSON.parse(
      buildExecutorMcpConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing })!,
    )
    expect(config.model).toBe('anthropic/claude-sonnet-4-5')
  })

  test('coexists with the executor MCP server in one config', () => {
    const config = JSON.parse(buildExecutorMcpConfigContent({ ...ENV, ...GATEWAY_ENV })!)
    expect(config.mcp['kortix-executor']).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })

  test('returns undefined when neither executor nor gateway env is present', () => {
    expect(buildExecutorMcpConfigContent({})).toBeUndefined()
  })

  test('returns config with provider only (no mcp) when executor env missing', () => {
    const config = JSON.parse(buildExecutorMcpConfigContent(GATEWAY_ENV)!)
    expect(config.provider.kortix).toBeDefined()
    expect(config.mcp).toBeUndefined()
  })

  test('declares reasoning + tool_call + attachment on capable Kortix models', () => {
    const config = JSON.parse(buildExecutorMcpConfigContent(GATEWAY_ENV)!)
    const models = config.provider.kortix.models
    expect(models['anthropic/claude-sonnet-4-5'].reasoning).toBe(true)
    expect(models['anthropic/claude-haiku-4-5'].reasoning).toBe(true)
    expect(models['anthropic/claude-opus-4-7'].reasoning).toBe(true)
    expect(models['anthropic/claude-sonnet-4-5'].tool_call).toBe(true)
    expect(models['anthropic/claude-sonnet-4-5'].attachment).toBe(true)
    expect(models['openai/gpt-4o'].reasoning).toBeUndefined()
    expect(models['openai/gpt-4o'].tool_call).toBe(true)
  })

  test('merges provider onto pre-existing inline provider block', () => {
    const existing = JSON.stringify({
      provider: { anthropic: { options: { timeout: 600000 } } },
    })
    const config = JSON.parse(
      buildExecutorMcpConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing })!,
    )
    expect(config.provider.anthropic).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })
})
