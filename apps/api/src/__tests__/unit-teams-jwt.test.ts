import { beforeEach, describe, expect, mock, test } from 'bun:test';

let claims: Record<string, unknown> = {};
mock.module('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => ({ payload: claims }),
}));
mock.module('../config', () => ({
  config: { MICROSOFT_APP_ID: 'app-1', MICROSOFT_BOT_OPENID_METADATA: 'https://meta.test/openid' },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: true, json: async () => ({ jwks_uri: 'https://meta.test/jwks' }) })) as unknown as typeof fetch;
const { validateInboundActivityJwt, resetTeamsJwksCacheForTest } = await import('../channels/teams/jwt');
globalThis.fetch = realFetch;

beforeEach(() => resetTeamsJwksCacheForTest());

describe('validateInboundActivityJwt service URL claim', () => {
  const call = (serviceUrl?: string) => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ jwks_uri: 'https://meta.test/jwks' }) })) as unknown as typeof fetch;
    return validateInboundActivityJwt('Bearer t', serviceUrl);
  };

  test('a matching claim passes, trailing slashes ignored', async () => {
    claims = { serviceurl: 'https://smba.trafficmanager.net/teams/' };
    expect(await call('https://smba.trafficmanager.net/teams')).toBe(true);
  });
  test('a different claim is refused', async () => {
    claims = { serviceurl: 'https://other.example/' };
    expect(await call('https://smba.trafficmanager.net/teams')).toBe(false);
  });
  test('a token with no service URL claim is refused when the activity names one', async () => {
    claims = {};
    expect(await call('https://smba.trafficmanager.net/teams')).toBe(false);
  });
  test('no activity service URL: nothing to compare', async () => {
    claims = {};
    expect(await call(undefined)).toBe(true);
  });
});
