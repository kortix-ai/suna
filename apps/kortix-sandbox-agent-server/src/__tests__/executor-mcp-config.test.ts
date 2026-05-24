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
