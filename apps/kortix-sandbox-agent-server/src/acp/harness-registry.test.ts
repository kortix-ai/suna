import { describe, expect, test } from 'bun:test'

import {
  createAcpHarnessRegistry,
  parseAcpHarnessId,
  resolveAcpHarnessLaunchEnv,
} from './harness-registry'

describe('ACP harness registry', () => {
  test('registers the four supported ACP harnesses', () => {
    const registry = createAcpHarnessRegistry({})

    expect([...registry.keys()]).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ])
    expect(registry.get('claude')).toMatchObject({
      displayName: 'Claude Code',
      adapter: '@agentclientprotocol/claude-agent-acp',
      launch: { command: 'claude-agent-acp', args: [] },
    })
    expect(registry.get('codex')).toMatchObject({
      displayName: 'Codex',
      adapter: '@agentclientprotocol/codex-acp',
      launch: { command: 'codex-acp', args: [] },
    })
    expect(registry.get('pi')).toMatchObject({
      displayName: 'Pi',
      adapter: 'pi-acp',
      launch: { command: 'pi-acp', args: [] },
    })
  })

  test('parses only supported harness identifiers', () => {
    expect(parseAcpHarnessId(' CLAUDE ')).toBe('claude')
    expect(parseAcpHarnessId('codex')).toBe('codex')
    expect(parseAcpHarnessId('pi')).toBe('pi')
    expect(parseAcpHarnessId('other')).toBeNull()
  })

  test('accepts explicit executable and JSON argument overrides', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_ACP_CODEX_PATH: '/test/codex-acp',
      KORTIX_ACP_CODEX_ARGS: '["--flag","value"]',
    })

    expect(registry.get('codex')?.launch).toEqual({
      command: '/test/codex-acp',
      args: ['--flag', 'value'],
    })
  })

  test('rejects malformed argument overrides', () => {
    expect(() =>
      createAcpHarnessRegistry({
        KORTIX_ACP_PI_ARGS: '--flag',
      }),
    ).toThrow('KORTIX_ACP_PI_ARGS must be a JSON string array')
  })

  test('routes managed Claude, Codex, and Pi traffic through Kortix', () => {
    const env = {
      HOME: '/home/kortix',
      KORTIX_API_URL: 'https://api.example.test/v1/',
      KORTIX_SANDBOX_TOKEN: 'sandbox-token',
    }

    expect(resolveAcpHarnessLaunchEnv('claude', env)).toMatchObject({
      CLAUDE_CONFIG_DIR: '/home/kortix/.claude',
      ANTHROPIC_BASE_URL: 'https://api.example.test/v1/router',
      ANTHROPIC_AUTH_TOKEN: 'sandbox-token',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    })
    expect(resolveAcpHarnessLaunchEnv('codex', env)).toMatchObject({
      CODEX_HOME: '/home/kortix/.codex',
      NO_BROWSER: '1',
      DEFAULT_AUTH_REQUEST: expect.stringContaining(
        'https://api.example.test/v1/router/openai',
      ),
    })
    expect(resolveAcpHarnessLaunchEnv('pi', env)).toMatchObject({
      PI_CODING_AGENT_DIR: '/home/kortix/.pi/agent',
      PI_TELEMETRY: '0',
      KORTIX_PI_MODELS_JSON: expect.stringContaining(
        'https://api.example.test/v1/router/openai',
      ),
    })
  })

  test('preserves direct provider credentials', () => {
    expect(
      resolveAcpHarnessLaunchEnv('claude', {
        HOME: '/home/kortix',
        ANTHROPIC_API_KEY: 'project-key',
        KORTIX_API_URL: 'https://api.example.test/v1',
        KORTIX_SANDBOX_TOKEN: 'sandbox-token',
      }),
    ).not.toHaveProperty('ANTHROPIC_BASE_URL')

    const codex = resolveAcpHarnessLaunchEnv('codex', {
      HOME: '/home/kortix',
      OPENAI_API_KEY: 'project-key',
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_SANDBOX_TOKEN: 'sandbox-token',
    })
    expect(codex.DEFAULT_AUTH_REQUEST).toBe(
      JSON.stringify({ methodId: 'api-key' }),
    )

    const pi = resolveAcpHarnessLaunchEnv('pi', {
      HOME: '/home/kortix',
      OPENAI_API_KEY: 'project-key',
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_SANDBOX_TOKEN: 'sandbox-token',
    })
    expect(pi.KORTIX_PI_MODELS_JSON).toContain(
      '"baseUrl":"https://api.openai.com/v1"',
    )
    expect(pi.KORTIX_PI_MODELS_JSON).toContain(
      '"apiKey":"$OPENAI_API_KEY"',
    )
    expect(pi.KORTIX_PI_MODELS_JSON).not.toContain(
      'api.example.test',
    )
  })
})
