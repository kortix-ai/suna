import { describe, expect, test } from 'bun:test';
import { createAcpHarnessRegistry } from '../acp/harness-registry';

describe('ACP harness registry', () => {
  test('uses image-stable absolute paths for installed ACP adapters', () => {
    const registry = createAcpHarnessRegistry({});
    expect(registry.get('claude')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    });
    expect(registry.get('codex')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'],
    });
    expect(registry.get('pi')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/pi-acp/dist/index.js'],
    });
  });

  test('routes Claude through the scoped Kortix Anthropic gateway by default', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1/',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(registry.get('claude')?.launch.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.test/v1/router',
      ANTHROPIC_AUTH_TOKEN: 'sandbox-token',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    });
  });

  test('preserves native Claude credentials when the project supplied them', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
      ANTHROPIC_API_KEY: 'project-key',
    });
    expect(registry.get('claude')?.launch.env).toBeUndefined();
  });

  test('routes Codex through the scoped Kortix Responses gateway by default', () => {
    const registry = createAcpHarnessRegistry({ KORTIX_API_URL: 'https://api.test/v1', KORTIX_TOKEN: 'token' });
    expect(registry.get('codex')?.launch.env).toEqual({
      NO_BROWSER: '1',
      CODEX_CONFIG: JSON.stringify({ model: 'openai/gpt-5.4' }),
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: 'gateway',
        _meta: {
          gateway: {
            baseUrl: 'https://api.test/v1/router/openai',
            providerName: 'Kortix Gateway',
            headers: { Authorization: 'Bearer token' },
          },
        },
      }),
    });
    expect(registry.get('opencode')?.launch.env).toBeUndefined();
    expect(registry.get('pi')?.launch.env).toMatchObject({
      PI_TELEMETRY: '0',
      KORTIX_PI_MODELS_JSON: expect.stringContaining('gpt-5.4'),
    });
  });

  test('preserves native Codex credentials when the project supplied them', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.test/v1',
      KORTIX_TOKEN: 'token',
      OPENAI_API_KEY: 'project-key',
    });
    expect(registry.get('codex')?.launch.env).toBeUndefined();
  });

  test('routes a logical Kortix agent to OpenCode through its native default agent', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_NATIVE_AGENT: 'reviewer',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }),
    });
    expect(JSON.parse(registry.get('opencode')?.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      permission: 'allow',
      default_agent: 'reviewer',
    });
  });

  test('maps the compiled runtime config directory to each harness native environment', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_RUNTIME_CONFIG_DIR: '.config/agent',
      KORTIX_WORKSPACE: '/workspace',
    });
    expect(registry.get('claude')?.launch.env).toEqual({ CLAUDE_CONFIG_DIR: '/workspace/.config/agent' });
    expect(registry.get('codex')?.launch.env).toEqual({ CODEX_HOME: '/workspace/.config/agent' });
    expect(registry.get('opencode')?.launch.env).toEqual({ OPENCODE_CONFIG_DIR: '/workspace/.config/agent' });
    expect(registry.get('pi')?.launch.env).toEqual({ PI_CODING_AGENT_DIR: '/workspace/.config/agent' });
  });
});
