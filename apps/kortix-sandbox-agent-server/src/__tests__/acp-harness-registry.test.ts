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
    expect(registry.get('pi')?.launch.env).toBeUndefined();
  });

  test('preserves native Codex credentials when the project supplied them', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.test/v1',
      KORTIX_TOKEN: 'token',
      OPENAI_API_KEY: 'project-key',
    });
    expect(registry.get('codex')?.launch.env).toBeUndefined();
  });
});
