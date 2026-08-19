import { describe, expect, test } from 'bun:test';
import {
  InvalidDeviceAuthResponseError,
  awaitDeviceAuthorization,
  parseDeviceAuthChallenge,
  parseDeviceAuthStatus,
} from './device-auth';

const VALID_TUNNEL_ID = '00000000-0000-4000-8000-000000000042';
const VALID_TOKEN = `kortix_tnl_${'A'.repeat(36)}`;

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    deviceCode: 'ABCD-1234',
    deviceSecret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    verificationUrl: 'https://kortix.com/tunnel/authorize/ABCD-1234',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    pollIntervalMs: 2000,
    ...overrides,
  };
}

describe('device auth challenge validation', () => {
  test('accepts a well-formed challenge', () => {
    const parsed = parseDeviceAuthChallenge(challenge());
    expect(parsed.deviceCode).toBe('ABCD-1234');
    expect(parsed.verificationUrl).toStartWith('https://kortix.com/');
  });

  test('rejects a verification URL that is not https and not loopback', () => {
    expect(() => parseDeviceAuthChallenge(challenge({ verificationUrl: 'http://evil.example/x' })))
      .toThrow(InvalidDeviceAuthResponseError);
  });

  test('allows a loopback URL over http for local development', () => {
    const parsed = parseDeviceAuthChallenge(
      challenge({ verificationUrl: 'http://127.0.0.1:3000/tunnel/authorize/ABCD-1234' }),
    );
    expect(parsed.verificationUrl).toContain('127.0.0.1');
  });

  test('rejects a URL carrying credentials', () => {
    expect(() => parseDeviceAuthChallenge(challenge({ verificationUrl: 'https://user:pw@kortix.com/x' })))
      .toThrow(/unsafe verification URL/);
  });

  test('rejects a non-http scheme outright', () => {
    expect(() => parseDeviceAuthChallenge(challenge({ verificationUrl: 'javascript:alert(1)' })))
      .toThrow(InvalidDeviceAuthResponseError);
  });

  test.each([
    ['device code', { deviceCode: 'nope' }],
    ['device secret', { deviceSecret: 'short' }],
    ['expiration in the past', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['expiration too far out', { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }],
    ['poll interval too small', { pollIntervalMs: 10 }],
    ['poll interval too large', { pollIntervalMs: 60_000 }],
  ])('rejects a bad %s', (_label, overrides) => {
    expect(() => parseDeviceAuthChallenge(challenge(overrides))).toThrow(InvalidDeviceAuthResponseError);
  });
});

describe('device auth status validation', () => {
  test('returns null while the request is still pending', () => {
    expect(parseDeviceAuthStatus({ status: 'pending' })).toBeNull();
  });

  test('narrows an approval to supported capabilities and dedupes them', () => {
    const outcome = parseDeviceAuthStatus({
      status: 'approved',
      tunnelId: VALID_TUNNEL_ID,
      token: VALID_TOKEN,
      capabilities: ['shell', 'shell', 'filesystem', 'root-access'],
    });
    expect(outcome).toEqual({
      status: 'approved',
      tunnelId: VALID_TUNNEL_ID,
      token: VALID_TOKEN,
      capabilities: ['shell', 'filesystem'],
    });
  });

  test('reports an approval that carries no token separately', () => {
    expect(parseDeviceAuthStatus({ status: 'approved' })).toEqual({ status: 'approved-without-token' });
  });

  test('rejects a malformed tunnel id', () => {
    expect(() => parseDeviceAuthStatus({ status: 'approved', tunnelId: 'nope', token: VALID_TOKEN }))
      .toThrow(/invalid tunnel ID/);
  });

  test('rejects a malformed setup token', () => {
    expect(() => parseDeviceAuthStatus({ status: 'approved', tunnelId: VALID_TUNNEL_ID, token: 'bad' }))
      .toThrow(/invalid setup token/);
  });

  test.each([['denied'], ['expired']])('passes %s through', (status) => {
    expect(parseDeviceAuthStatus({ status })).toEqual({ status } as never);
  });
});

describe('polling', () => {
  test('retries transport failures and stops on a decision', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error('network down');
      return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const outcome = await awaitDeviceAuthorization('http://127.0.0.1:1/v1/tunnel', challenge(), {
        sleep: async () => {},
      });
      expect(outcome).toEqual({ status: 'denied' });
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('gives up once the challenge has expired', async () => {
    const outcome = await awaitDeviceAuthorization(
      'http://127.0.0.1:1/v1/tunnel',
      { ...challenge(), expiresAt: new Date(Date.now() - 1).toISOString() },
      { sleep: async () => {} },
    );
    expect(outcome).toEqual({ status: 'expired' });
  });
});
