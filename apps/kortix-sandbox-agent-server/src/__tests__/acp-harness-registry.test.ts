import { describe, expect, test } from 'bun:test';
import { createAcpHarnessRegistry } from '../acp/harness-registry';

describe('ACP harness registry', () => {
  test('routes Claude through the scoped Kortix Anthropic gateway by default', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1/',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(registry.get('claude')?.launch.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.test/v1/router',
      ANTHROPIC_AUTH_TOKEN: 'sandbox-token',
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

  test('does not leak the Claude gateway environment into other harnesses', () => {
    const registry = createAcpHarnessRegistry({ KORTIX_API_URL: 'https://api.test/v1', KORTIX_TOKEN: 'token' });
    expect(registry.get('codex')?.launch.env).toBeUndefined();
    expect(registry.get('opencode')?.launch.env).toBeUndefined();
    expect(registry.get('pi')?.launch.env).toBeUndefined();
  });
});
