import { describe, expect, test } from 'bun:test';

import {
  buildHarnessConnections,
  readHarnessAuthRoutes,
  resolveActiveHarnessConnection,
  writeHarnessAuthRoute,
} from './composer-capabilities';

describe('composer capability auth resolution', () => {
  test('keeps Claude subscription and Anthropic API key as separate connections', () => {
    const connections = buildHarnessConnections({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
        ANTHROPIC_API_KEY: 'api-key',
      },
      gatewayEnabled: false,
    });
    expect(connections.find((item) => item.id === 'claude_subscription')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'anthropic_api_key')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'codex_subscription')?.ready).toBe(false);
  });

  test('keeps Codex subscription and OpenAI API key as separate connections', () => {
    const connections = buildHarnessConnections({
      env: { CODEX_AUTH_JSON: '{}', OPENAI_API_KEY: 'api-key' },
      gatewayEnabled: false,
    });
    expect(connections.find((item) => item.id === 'codex_subscription')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'openai_api_key')?.ready).toBe(true);
  });

  test('managed gateway is the deterministic default until an explicit route is stored', () => {
    const connections = buildHarnessConnections({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'subscription' },
      gatewayEnabled: true,
    });
    expect(resolveActiveHarnessConnection({ harness: 'claude', connections }).active?.id).toBe('managed_gateway');
    expect(resolveActiveHarnessConnection({
      harness: 'claude',
      connections,
      explicit: 'claude_subscription',
    }).active?.id).toBe('claude_subscription');
  });

  test('two native credentials require an explicit choice when the gateway is disabled', () => {
    const connections = buildHarnessConnections({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'subscription', ANTHROPIC_API_KEY: 'api-key' },
      gatewayEnabled: false,
    });
    const result = resolveActiveHarnessConnection({ harness: 'claude', connections });
    expect(result.active).toBeNull();
    expect(result.reason).toContain('Choose');
  });

  test('native config is not ready merely because a runtime has a conventional directory', () => {
    const missing = buildHarnessConnections({
      env: {},
      gatewayEnabled: false,
    });
    expect(missing.find((item) => item.id === 'native_config')).toMatchObject({
      configured: false,
      ready: false,
    });

    const present = buildHarnessConnections({
      env: {},
      gatewayEnabled: false,
      nativeConfigReady: true,
    });
    expect(present.find((item) => item.id === 'native_config')).toMatchObject({
      configured: true,
      ready: true,
    });
  });

  test('active bindings round-trip without disturbing other project metadata', () => {
    const metadata = writeHarnessAuthRoute({ existing: true }, 'codex', 'codex_subscription');
    expect(readHarnessAuthRoutes(metadata)).toEqual({ codex: 'codex_subscription' });
    expect(metadata.existing).toBe(true);
    expect(readHarnessAuthRoutes(writeHarnessAuthRoute(metadata, 'codex', null))).toEqual({});
  });
});
