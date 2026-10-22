import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultGatewayUrl, inferTarget } from '../src/core/env';

describe('release target inference', () => {
  it('classifies the staging API and selects the staging gateway', () => {
    expect(inferTarget('https://staging-api.kortix.com/v1')).toBe('staging');
    expect(defaultGatewayUrl('staging')).toBe('https://gateway-staging.kortix.com');
  });

  it('keeps dev, prod, and local gateway defaults isolated', () => {
    expect(defaultGatewayUrl('dev')).toBe('https://gateway-dev.kortix.com');
    expect(defaultGatewayUrl('prod')).toBe('https://gateway.kortix.com');
    expect(defaultGatewayUrl('local')).toBe('http://localhost:8009');
  });
});

// loadEnv caches per module instance, so each case reads a fresh module.
async function freshEnv(vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import('../src/core/env')).loadEnv();
}

describe('Mailpit is an optional env value, not a capability', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads KE2E_MAILPIT_URL first, then E2E_MAILPIT_URL', async () => {
    const both = await freshEnv({ KE2E_MAILPIT_URL: 'http://127.0.0.1:54324', E2E_MAILPIT_URL: 'https://preview.example/_mailpit' });
    expect(both.mailpitUrl).toBe('http://127.0.0.1:54324');
    const preview = await freshEnv({ KE2E_MAILPIT_URL: '', E2E_MAILPIT_URL: 'https://preview.example/_mailpit' });
    expect(preview.mailpitUrl).toBe('https://preview.example/_mailpit');
  });

  // A capability staging lacks would fail `--require-all` on the prod release gate.
  it('is null without either, and adds no capability', async () => {
    const env = await freshEnv({ KE2E_MAILPIT_URL: '', E2E_MAILPIT_URL: '' });
    expect(env.mailpitUrl).toBeNull();
    expect(Object.keys(env.capabilities).some((name) => /mail/i.test(name))).toBe(false);
  });
});
