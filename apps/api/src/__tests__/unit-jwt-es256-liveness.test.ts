import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

/**
 * ES256 (JWKS) access tokens must pass the same GoTrue liveness check as HS256.
 *
 * Staging and prod publish ES256 keys. The JWKS verifier checked signature,
 * `exp` and `sub` only, so a token whose session was logged out, banned or
 * deleted stayed valid until `exp` (~1 h) on every route without the account
 * session gate (for example `GET /v1/accounts/me`).
 */

process.env.SUPABASE_JWT_LIVENESS_TTL_MS = '30000';

const USER = '00000000-0000-4000-8000-00000000a001';
const KID = 'synthetic-es256-kid';

const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

// Serve the test JWKS before `jwt-verify` loads it on import.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  String(input).endsWith('/.well-known/jwks.json')
    ? Response.json({ keys: [jwk] })
    : realFetch(input, init)) as typeof fetch;

type Verify = typeof import('../shared/jwt-verify').verifySupabaseJwt;
type Liveness = typeof import('../shared/jwt-liveness');
type Outcome = typeof import('../shared/jwt-verify-outcome').isInconclusiveVerifyFailure;
let verifySupabaseJwt: Verify;
let liveness: Liveness;
let isInconclusive: Outcome;

beforeAll(async () => {
  ({ verifySupabaseJwt } = await import('../shared/jwt-verify'));
  liveness = await import('../shared/jwt-liveness');
  ({ isInconclusiveVerifyFailure: isInconclusive } = await import('../shared/jwt-verify-outcome'));
});

afterEach(() => liveness.__setJwtLivenessLoaderForTests(null));

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

async function sign(payload: Record<string, unknown>): Promise<string> {
  const head = `${b64({ alg: 'ES256', typ: 'JWT', kid: KID })}.${b64(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
}

function loader(answer: () => Promise<{ id: string; email: string } | null>) {
  const calls: string[] = [];
  liveness.__setJwtLivenessLoaderForTests(async (token) => {
    calls.push(token);
    return answer();
  });
  return calls;
}

describe('ES256 tokens', () => {
  test('a live token verifies, and GoTrue is asked once per TTL', async () => {
    const calls = loader(async () => ({ id: USER, email: 'synthetic@example.test' }));
    const token = await sign({ sub: USER, exp: inAnHour() });
    const results = await Promise.all([verifySupabaseJwt(token), verifySupabaseJwt(token), verifySupabaseJwt(token)]);
    for (const result of results) expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  test('a token whose session GoTrue revoked is a definitive rejection', async () => {
    loader(async () => null);
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: inAnHour() }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session-not-live');
    expect(isInconclusive(result.reason)).toBe(false);
  });

  test('a liveness answer for a different user is a rejection', async () => {
    loader(async () => ({ id: '00000000-0000-4000-8000-00000000b002', email: '' }));
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: inAnHour() }));
    expect(result.ok).toBe(false);
  });

  test('logout drops the cached verdict so the next request asks GoTrue again', async () => {
    let live = true;
    loader(async () => (live ? { id: USER, email: '' } : null));
    const token = await sign({ sub: USER, exp: inAnHour() });
    expect((await verifySupabaseJwt(token)).ok).toBe(true);
    live = false;
    liveness.forgetJwtLiveness(token);
    expect((await verifySupabaseJwt(token)).ok).toBe(false);
  });

  test('GoTrue unreachable is inconclusive, so the caller falls back to the network path', async () => {
    loader(async () => {
      throw new Error('gotrue down');
    });
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: inAnHour() }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('liveness-unavailable');
    expect(isInconclusive(result.reason)).toBe(true);
  });

  test('a forged signature and an expired token never reach GoTrue', async () => {
    const calls = loader(async () => ({ id: USER, email: '' }));
    const good = await sign({ sub: USER, exp: inAnHour() });
    const forged = `${good.slice(0, good.lastIndexOf('.'))}.${Buffer.alloc(64, 1).toString('base64url')}`;
    const expired = await sign({ sub: USER, exp: Math.floor(Date.now() / 1000) - 10 });
    expect((await verifySupabaseJwt(forged)).ok).toBe(false);
    expect((await verifySupabaseJwt(expired)).ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
