import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

/**
 * Asymmetric (ES256) tokens ask GoTrue for liveness too (2026-10-01).
 *
 * Local Supabase and any project on Supabase signing keys issue ES256 tokens.
 * The JWKS path checked signature and expiry only, so a session revoked by
 * `POST /v1/auth/logout` kept authenticating until `exp` — AUTH-1 saw 200 from
 * `/v1/accounts/me` after logout. Revocation must not depend on the algorithm.
 */

process.env.SUPABASE_JWT_LIVENESS_TTL_MS = '0';

type Verify = typeof import('../shared/jwt-verify').verifySupabaseJwt;
type Liveness = typeof import('../shared/jwt-liveness');
let verifySupabaseJwt: Verify;
let liveness: Liveness;
let server: ReturnType<typeof Bun.serve>;
let privateKey: CryptoKey;
let previousUrl: string;

const KID = 'unit-test-es256-kid';
const USER = '00000000-0000-4000-8000-00000000e001';
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function sign(payload: Record<string, unknown>): Promise<string> {
  const head = `${b64({ alg: 'ES256', kid: KID, typ: 'JWT' })}.${b64(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(head),
  );
  return `${head}.${Buffer.from(signature).toString('base64url')}`;
}

function countingLoader(answer: () => Promise<{ id: string; email: string } | null>) {
  const calls: string[] = [];
  liveness.__setJwtLivenessLoaderForTests(async (token) => {
    calls.push(token);
    return answer();
  });
  return calls;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [{ ...jwk, alg: 'ES256', kid: KID, use: 'sig' }] }),
  });
  const { config } = await import('../config');
  previousUrl = config.SUPABASE_URL;
  config.SUPABASE_URL = `http://127.0.0.1:${server.port}`;
  ({ verifySupabaseJwt } = await import('../shared/jwt-verify'));
  liveness = await import('../shared/jwt-liveness');
});

afterEach(() => {
  liveness.__setJwtLivenessLoaderForTests(null);
});

afterAll(async () => {
  const { config } = await import('../config');
  config.SUPABASE_URL = previousUrl;
  server.stop(true);
});

describe('ES256 tokens verified through the JWKS', () => {
  test('a live session verifies and GoTrue is asked', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: 'synthetic@example.test' }));
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: inAnHour(), aal: 'aal1' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(USER);
      expect(result.payload.aal).toBe('aal1');
    }
    expect(calls).toHaveLength(1);
  });

  test('a session revoked by logout is refused on its next verification', async () => {
    let live = true;
    countingLoader(async () => (live ? { id: USER, email: '' } : null));
    const token = await sign({ sub: USER, exp: inAnHour() });

    expect((await verifySupabaseJwt(token)).ok).toBe(true);
    live = false;
    expect(await verifySupabaseJwt(token)).toEqual({ ok: false, reason: 'session-not-live' });
  });

  test('an expired token is refused without asking GoTrue', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: '' }));
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: Math.floor(Date.now() / 1000) - 5 }));

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(calls).toHaveLength(0);
  });

  test('GoTrue being unreachable is inconclusive, so the caller falls back to the network path', async () => {
    countingLoader(async () => {
      throw new Error('gotrue unreachable');
    });
    const result = await verifySupabaseJwt(await sign({ sub: USER, exp: inAnHour() }));

    expect(result).toEqual({ ok: false, reason: 'liveness-unavailable' });
  });
});
