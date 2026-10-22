import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { AuthClient } from '@supabase/supabase-js';
import type { FetchFunction } from '@/lib/utils/with-deadline';
import { createRefreshGuardFetch, isDefinitiveRefreshRejection } from './refresh-fetch';

const AUTH_URL = 'https://synthetic.invalid/auth/v1';
const REFRESH_URL = `${AUTH_URL}/token?grant_type=refresh_token`;
const POST: RequestInit = { method: 'POST', body: '{}' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
  });
}

/** Refresh answers that say nothing about the refresh token. */
const NOT_DEFINITIVE: Record<string, () => Response> = {
  'JSON 429': () => json(429, { code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
  'JSON 408': () => json(408, { code: 'request_timeout', msg: 'Request timeout' }),
  'HTML 403': () => new Response('<html>blocked</html>', { status: 403 }),
  'empty 403': () => new Response(null, { status: 403 }),
};
const NOT_FOUND = () => json(400, { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });

describe('isDefinitiveRefreshRejection', () => {
  test('a 400/401/403 with a dead-login code is definitive', () => {
    expect(isDefinitiveRefreshRejection(400, { code: 'refresh_token_not_found' })).toBe(true);
    expect(isDefinitiveRefreshRejection(400, { code: 'refresh_token_already_used' })).toBe(true);
    expect(isDefinitiveRefreshRejection(403, { code: 'session_not_found' })).toBe(true);
    expect(isDefinitiveRefreshRejection(401, { error_code: 'session_expired' })).toBe(true);
    expect(isDefinitiveRefreshRejection(400, { error_code: 'user_not_found' })).toBe(true);
    expect(isDefinitiveRefreshRejection(400, { code: 'user_banned' })).toBe(true);
    expect(isDefinitiveRefreshRejection(400, { code: 'validation_failed' })).toBe(true);
  });

  test('any other status, code or body is not', () => {
    expect(isDefinitiveRefreshRejection(429, { code: 'refresh_token_not_found' })).toBe(false);
    expect(isDefinitiveRefreshRejection(500, { code: 'refresh_token_not_found' })).toBe(false);
    expect(isDefinitiveRefreshRejection(400, { code: 'unexpected_failure' })).toBe(false);
    expect(isDefinitiveRefreshRejection(403, { msg: 'Forbidden' })).toBe(false);
    expect(isDefinitiveRefreshRejection(403, null)).toBe(false);
    expect(isDefinitiveRefreshRejection(403, '<html>blocked</html>')).toBe(false);
  });
});

describe('createRefreshGuardFetch', () => {
  const guarded = (response: Response) => createRefreshGuardFetch(async () => response);

  test('returns an ok refresh answer and a definitive rejection', async () => {
    const ok = json(200, { access_token: 'a' });
    expect(await guarded(ok)(REFRESH_URL, POST)).toBe(ok);
    const dead = NOT_FOUND();
    const answer = await guarded(dead)(REFRESH_URL, POST);
    expect(answer).toBe(dead);
    // auth-js still reads the body.
    expect(((await answer.json()) as { code: string }).code).toBe('refresh_token_not_found');
  });

  for (const [name, response] of Object.entries({
    ...NOT_DEFINITIVE,
    'JSON 400 with another code': () => json(400, { code: 'unexpected_failure' }),
  })) {
    test(`throws for a ${name} refresh answer`, async () => {
      await expect(guarded(response())(REFRESH_URL, POST)).rejects.toThrow(TypeError);
    });
  }

  test('passes every other request through unchanged', async () => {
    const forbidden = json(403, { code: 'insufficient_aal' });
    expect(await guarded(forbidden)(`${AUTH_URL}/user`, { method: 'GET' })).toBe(forbidden);
    expect(await guarded(forbidden)(`${AUTH_URL}/token?grant_type=password`, POST)).toBe(forbidden);
  });
});

describe('the installed auth client with the guard', () => {
  const STORAGE_KEY = 'sb-synthetic-auth-token';
  const realNow = Date.now;
  let clockSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    clockSpy?.mockRestore();
    clockSpy = null;
  });

  /**
   * A stored session whose access token expired 60 s ago, and a client that
   * refreshes it on `getSession()`. Each refresh request moves the clock 30 s
   * on, so auth-js does not retry a failure for 25 s inside one test.
   */
  async function refreshExpiredSession(answer: () => Response, wrap: (f: FetchFunction) => FetchFunction) {
    let skew = 0;
    clockSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    const storage = new Map<string, string>();
    const expiresAt = Math.floor(realNow() / 1000) - 60;
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: expiresAt,
        user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated' },
      }),
    );
    let refreshes = 0;
    const server: FetchFunction = async (input) => {
      if (!String(input).includes('grant_type=refresh_token')) return json(404, { code: 'not_mocked' });
      refreshes++;
      skew += 30_000;
      return answer();
    };
    const events: string[] = [];
    const client = new AuthClient({
      url: AUTH_URL,
      headers: { apikey: 'synthetic-anon' },
      storageKey: STORAGE_KEY,
      storage: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => void storage.set(key, value),
        removeItem: async (key: string) => void storage.delete(key),
      },
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      fetch: wrap(server) as typeof fetch,
    });
    client.onAuthStateChange((event) => {
      events.push(event);
    });
    await client.getSession();
    return { stored: storage.has(STORAGE_KEY), events, refreshes };
  }

  for (const [name, answer] of Object.entries(NOT_DEFINITIVE)) {
    test(`a ${name} refresh answer keeps the stored session`, async () => {
      const result = await refreshExpiredSession(answer, createRefreshGuardFetch);
      expect(result.refreshes).toBeGreaterThan(0);
      expect(result.stored).toBe(true);
      expect(result.events).not.toContain('SIGNED_OUT');
    });
  }

  test('a refresh_token_not_found answer ends the login', async () => {
    const result = await refreshExpiredSession(NOT_FOUND, createRefreshGuardFetch);
    expect(result.stored).toBe(false);
    expect(result.events).toContain('SIGNED_OUT');
  });
});
