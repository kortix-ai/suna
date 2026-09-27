import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

/**
 * Local HS256 verification + the GoTrue liveness cache (2026-09-23).
 *
 * Prod GoTrue signs HS256; before this change every authenticated request paid
 * a GoTrue `getUser` round trip. These tests pin the security contract that
 * made removing it acceptable:
 *   - a forged or mis-keyed token never passes locally,
 *   - an expired token is a definitive rejection,
 *   - GoTrue still decides liveness, at most once per token per TTL,
 *   - only positive answers are cached, never past the token's own `exp`,
 *   - sign-out drops the cached answer at once,
 *   - our own misconfiguration degrades to the network path, never to a 401.
 */

const SECRET = 'unit-test-hs256-secret-not-real-0123456789';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.SUPABASE_JWT_LIVENESS_TTL_MS = '30000';

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

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

const USER = '00000000-0000-4000-8000-00000000a001';
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function countingLoader(answer: () => Promise<{ id: string; email: string } | null>) {
  const calls: string[] = [];
  liveness.__setJwtLivenessLoaderForTests(async (token) => {
    calls.push(token);
    return answer();
  });
  return calls;
}

afterEach(() => {
  liveness.__setJwtLivenessLoaderForTests(null);
});

describe('HS256 tokens with SUPABASE_JWT_SECRET configured', () => {
  test('a valid live token verifies locally and GoTrue is asked once per TTL', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: 'synthetic@example.test' }));
    const token = sign({ sub: USER, role: 'authenticated', exp: inAnHour(), aal: 'aal1' });

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => verifySupabaseJwt(token)));
    const again = await verifySupabaseJwt(token);

    for (const result of [...results, again]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.userId).toBe(USER);
        expect(result.payload.aal).toBe('aal1');
      }
    }
    // One burst of 5 concurrent requests + 1 later request = ONE GoTrue call.
    expect(calls.length).toBe(1);
  });

  test('a token signed with a different secret never passes, and routes to the network path', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: '' }));
    const forged = sign({ sub: USER, exp: inAnHour() }, 'attacker-guess');

    const result = await verifySupabaseJwt(forged);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Inconclusive on purpose: a stale secret on our side must not 401 every
    // user. The network path (GoTrue) then rejects the forgery.
    expect(isInconclusive(result.reason)).toBe(true);
    expect(calls.length).toBe(0);
  });

  test('an expired token is a definitive rejection without asking GoTrue', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: '' }));
    const token = sign({ sub: USER, exp: Math.floor(Date.now() / 1000) - 5 });

    const result = await verifySupabaseJwt(token);

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(calls.length).toBe(0);
  });

  test('a token without a subject (anon / service keys) is rejected', async () => {
    countingLoader(async () => ({ id: USER, email: '' }));
    const result = await verifySupabaseJwt(sign({ role: 'anon', exp: inAnHour() }));
    expect(result).toEqual({ ok: false, reason: 'no-sub' });
  });

  test('a revoked session is rejected, and the rejection is never cached', async () => {
    let live = false;
    const calls = countingLoader(async () => (live ? { id: USER, email: '' } : null));
    const token = sign({ sub: USER, exp: inAnHour() });

    const first = await verifySupabaseJwt(token);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe('session-not-live');
      expect(isInconclusive(first.reason)).toBe(false);
    }

    live = true;
    expect((await verifySupabaseJwt(token)).ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  test('GoTrue answering for a different user is rejected', async () => {
    countingLoader(async () => ({ id: '00000000-0000-4000-8000-00000000b002', email: '' }));
    const result = await verifySupabaseJwt(sign({ sub: USER, exp: inAnHour() }));
    expect(result).toEqual({ ok: false, reason: 'session-not-live' });
  });

  test('GoTrue being unreachable is inconclusive and is not cached', async () => {
    let fail = true;
    const calls = countingLoader(async () => {
      if (fail) throw new Error('gotrue unreachable');
      return { id: USER, email: '' };
    });
    const token = sign({ sub: USER, exp: inAnHour() });

    const down = await verifySupabaseJwt(token);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(isInconclusive(down.reason)).toBe(true);

    fail = false;
    expect((await verifySupabaseJwt(token)).ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  test('sign-out drops the cached confirmation, so the next request asks GoTrue again', async () => {
    let live = true;
    const calls = countingLoader(async () => (live ? { id: USER, email: '' } : null));
    const token = sign({ sub: USER, exp: inAnHour() });

    expect((await verifySupabaseJwt(token)).ok).toBe(true);
    live = false;
    liveness.forgetJwtLiveness(token);

    expect((await verifySupabaseJwt(token)).ok).toBe(false);
    expect(calls.length).toBe(2);
  });
});

describe('confirmJwtLive cache bounds', () => {
  test('a confirmation never outlives the token exp', async () => {
    const calls = countingLoader(async () => ({ id: USER, email: '' }));
    const exp = Math.floor(Date.now() / 1000) + 1; // expires in ≤ 1 s

    await liveness.confirmJwtLive('token-a', exp);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await liveness.confirmJwtLive('token-a', exp);

    expect(calls.length).toBe(2);
  });

  test('the raw token is not what the cache is keyed by', async () => {
    countingLoader(async () => ({ id: USER, email: '' }));
    await liveness.confirmJwtLive('token-b', inAnHour());
    expect(liveness.jwtLivenessCacheSize()).toBe(1);
  });
});
