/**
 * Per-user token-bucket rate limiting (`src/server/rate-limit.ts`) as
 * enforced by the proxy. Dedicated boot with a small `RATE_LIMIT_PER_MIN` so
 * the bucket empties (and refills) fast enough for a deterministic test.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

const CAPACITY = 30; // RATE_LIMIT_PER_MIN — refills 1 token/2s, fast enough for a deterministic test

describe('rate limiting', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(
      wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1`, RATE_LIMIT_PER_MIN: String(CAPACITY) }),
    );
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('exceeding the per-minute budget returns 429 with Retry-After, then recovers', async () => {
    const email = uniqueEmail('rate-limit');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const hit = () =>
      fetch(`${app.baseUrl}/api/kortix/accounts/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

    // Drain the bucket.
    for (let i = 0; i < CAPACITY; i++) {
      const res = await hit();
      expect(res.status).toBe(200);
    }

    // The next request should be rate-limited.
    const limited = await hit();
    expect(limited.status).toBe(429);
    const retryAfterHeader = limited.headers.get('retry-after');
    expect(retryAfterHeader).toBeTruthy();
    const retryAfterSeconds = Number(retryAfterHeader);
    expect(Number.isFinite(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Rate limit exceeded' });

    // A different user has their own bucket and is unaffected.
    const otherEmail = uniqueEmail('rate-limit-other');
    const otherToken = await loginUser(app, otherEmail, DEMO_PASSWORD);
    const otherRes = await fetch(`${app.baseUrl}/api/kortix/accounts/me`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherRes.status).toBe(200);

    // After waiting out Retry-After, the original user's bucket has refilled.
    await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000 + 250));
    const recovered = await hit();
    expect(recovered.status).toBe(200);
  }, 20_000);
});
