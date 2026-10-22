import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import {
  SESSION_LIVENESS_TTL_MS,
  cookieIdentityPlan,
  isDeadSessionAuthError,
  resolveMiddlewareIdentity,
  type MiddlewareAuth,
} from './middleware-identity';

/** Build a fake auth surface and record which calls the resolver actually made. */
function fakeAuth(overrides: Partial<MiddlewareAuth>) {
  const calls: string[] = [];
  const auth: MiddlewareAuth = {
    getClaims: async () => {
      calls.push('getClaims');
      return { data: null, error: null };
    },
    getUser: async () => {
      calls.push('getUser');
      return { data: { user: null }, error: null };
    },
    ...overrides,
  };
  // Re-wrap the overrides so they are recorded too.
  const recorded: MiddlewareAuth = {
    getClaims: async () => {
      calls.push('getClaims');
      return auth.getClaims();
    },
    getUser: async () => {
      calls.push('getUser');
      return auth.getUser();
    },
  };
  return { auth: recorded, calls };
}

/** Verified claims for one session. Every test uses its own session id: the liveness cache is module state. */
function claimsFor(sessionId: string, extra: Record<string, unknown> = {}) {
  return async () => ({
    data: { claims: { sub: 'user-123', session_id: sessionId, user_metadata: { locale: 'de' }, ...extra } },
    error: null,
  });
}

const liveUser = async () => ({ data: { user: { id: 'user-123', user_metadata: { locale: 'de' } } }, error: null });

/** What GoTrue answers for the access token of a signed-out session. */
const signedOut = Object.assign(new Error('Session from session_id claim in JWT does not exist'), {
  status: 403,
  code: 'session_not_found',
});

afterEach(() => setSystemTime());

describe('resolveMiddlewareIdentity', () => {
  test('a verified JWT is confirmed live with GoTrue once; within the TTL the next request costs no network call', async () => {
    const { auth, calls } = fakeAuth({ getClaims: claimsFor('session-live'), getUser: liveUser });

    const first = await resolveMiddlewareIdentity(auth);
    const second = await resolveMiddlewareIdentity(auth);

    expect(first.user).toEqual({ id: 'user-123', user_metadata: { locale: 'de' } });
    expect(first.authError).toBeNull();
    expect(second.user).toEqual({ id: 'user-123', user_metadata: { locale: 'de' } });
    expect(second.source).toBe('claims');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(1);
  });

  test('a signed-out session resolves no user although its signature still verifies (KRTX-2387)', async () => {
    const { auth } = fakeAuth({
      getClaims: claimsFor('session-signed-out'),
      getUser: async () => ({ data: { user: null }, error: signedOut }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toBeNull();
    expect((identity.authError as { code?: string } | null)?.code).toBe('session_not_found');
  });

  test('a session confirmed live is asked again once the TTL passes, and a sign-out in between is seen', async () => {
    setSystemTime(new Date(1_000_000));
    let revoked = false;
    const { auth, calls } = fakeAuth({
      getClaims: claimsFor('session-ttl', { exp: 1_000_000 / 1000 + 3600 }),
      getUser: async () => (revoked ? { data: { user: null }, error: signedOut } : liveUser()),
    });

    expect((await resolveMiddlewareIdentity(auth)).user?.id).toBe('user-123');
    revoked = true;
    setSystemTime(new Date(1_000_000 + SESSION_LIVENESS_TTL_MS - 1));
    expect((await resolveMiddlewareIdentity(auth)).user?.id).toBe('user-123');
    setSystemTime(new Date(1_000_000 + SESSION_LIVENESS_TTL_MS + 1));
    expect((await resolveMiddlewareIdentity(auth)).user).toBeNull();
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(2);
  });

  test("a confirmation never outlives the token's own exp", async () => {
    setSystemTime(new Date(2_000_000));
    const { auth, calls } = fakeAuth({
      getClaims: claimsFor('session-exp', { exp: 2_000_000 / 1000 + 5 }),
      getUser: liveUser,
    });

    await resolveMiddlewareIdentity(auth);
    setSystemTime(new Date(2_000_000 + 5_001));
    await resolveMiddlewareIdentity(auth);

    expect(calls.filter((c) => c === 'getUser')).toHaveLength(2);
  });

  test('GoTrue unreachable is no verdict: the verified identity renders, and nothing is cached', async () => {
    let down = true;
    const { auth, calls } = fakeAuth({
      getClaims: claimsFor('session-gotrue-down'),
      getUser: async () => {
        if (down) throw Object.assign(new Error('fetch failed'), { status: 0 });
        return liveUser();
      },
    });

    const identity = await resolveMiddlewareIdentity(auth);
    expect(identity.user).toEqual({ id: 'user-123', user_metadata: { locale: 'de' } });
    expect(identity.authError).toBeNull();
    expect(identity.source).toBe('claims');

    down = false;
    await resolveMiddlewareIdentity(auth);
    await resolveMiddlewareIdentity(auth);
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(2);
  });

  test('a 5xx from GoTrue is no verdict either', async () => {
    const { auth } = fakeAuth({
      getClaims: claimsFor('session-gotrue-5xx'),
      getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('upstream'), { status: 502 }) }),
    });

    const identity = await resolveMiddlewareIdentity(auth);
    expect(identity.user?.id).toBe('user-123');
    expect(identity.authError).toBeNull();
  });

  test('an anonymous request costs no network call at all', async () => {
    // getSession() found nothing: no claims, and no error either.
    const { auth, calls } = fakeAuth({
      getClaims: async () => ({ data: null, error: null }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toBeNull();
    expect(identity.authError).toBeNull();
    expect(identity.source).toBe('no-session');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(0);
  });

  test('claims without a subject are not an identity — it falls back to getUser', async () => {
    const { auth, calls } = fakeAuth({
      getClaims: async () => ({ data: { claims: { email: 'a@b.c' } }, error: null }),
      getUser: async () => ({ data: { user: { id: 'user-9' } }, error: null }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toEqual({ id: 'user-9' });
    expect(identity.source).toBe('get-user');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(1);
  });

  test('an expired token falls back to getUser so the session can still refresh', async () => {
    const expired = Object.assign(new Error('JWT has expired'), { code: 'jwt_expired' });
    const { auth, calls } = fakeAuth({
      getClaims: async () => ({ data: null, error: expired }),
      getUser: async () => ({ data: { user: { id: 'user-refreshed' } }, error: null }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toEqual({ id: 'user-refreshed' });
    expect(identity.authError).toBeNull();
    expect(identity.source).toBe('get-user');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(1);
  });

  test('a rotated refresh token keeps its error code so the caller can self-heal', async () => {
    const rotated = Object.assign(new Error('Already Used'), {
      code: 'refresh_token_already_used',
    });
    const { auth } = fakeAuth({
      getClaims: async () => ({ data: null, error: rotated }),
      getUser: async () => ({ data: { user: null }, error: rotated }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toBeNull();
    expect((identity.authError as { code?: string } | null)?.code).toBe(
      'refresh_token_already_used',
    );
  });

  test('getClaims rethrowing a non-auth error never escapes the resolver', async () => {
    // WebCrypto importKey throws a DOMException, which getClaims rethrows.
    const { auth, calls } = fakeAuth({
      getClaims: async () => {
        throw new TypeError('Unsupported key algorithm');
      },
      getUser: async () => ({ data: { user: { id: 'user-fallback' } }, error: null }),
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toEqual({ id: 'user-fallback' });
    expect(identity.source).toBe('get-user');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(1);
  });

  test('getUser throwing is captured as an auth error, not propagated', async () => {
    const { auth } = fakeAuth({
      getClaims: async () => ({ data: null, error: new Error('boom') }),
      getUser: async () => {
        throw new Error('network down');
      },
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toBeNull();
    expect(identity.authError?.message).toBe('network down');
    expect(identity.source).toBe('get-user');
  });
});

describe('cookieIdentityPlan', () => {
  test('no session cookie resolves absent', () => {
    expect(cookieIdentityPlan(null, 1_000_000)).toBe('absent');
  });

  test('a fresh session cookie resolves fresh', () => {
    // expires_at 1000 s ahead of `now` (1_000_000 ms).
    expect(cookieIdentityPlan(2_000, 1_000_000)).toBe('fresh');
  });

  test('a cookie inside the auth-js refresh margin is stale, not fresh', () => {
    // 60 s of life left is inside the 90 s margin auth-js refreshes at.
    expect(cookieIdentityPlan(1_006, 1_000_000)).toBe('stale');
  });

  test('an expired session cookie is stale', () => {
    expect(cookieIdentityPlan(999, 1_000_000)).toBe('stale');
  });

  test('the margin comparison matches auth-js exactly (strict <, 90 s)', () => {
    // auth-js refreshes only when remaining life < 90_000 ms, so 90 s left is
    // still fresh for both, and 89 s is stale for both.
    expect(cookieIdentityPlan(1_090, 1_000_000)).toBe('fresh');
    expect(cookieIdentityPlan(1_089, 1_000_000)).toBe('stale');
  });
});

describe('isDeadSessionAuthError', () => {
  test('session_not_found is a death verdict (KRTX-2387)', () => {
    expect(isDeadSessionAuthError(signedOut)).toBe(true);
  });

  test('refresh-token rotation verdicts are death verdicts', () => {
    expect(isDeadSessionAuthError({ code: 'refresh_token_already_used' })).toBe(true);
    expect(isDeadSessionAuthError({ code: 'refresh_token_not_found' })).toBe(true);
  });

  test('an older GoTrue naming the refresh token in the message alone is a death verdict', () => {
    expect(isDeadSessionAuthError(new Error('Invalid Refresh Token: Already Used'))).toBe(true);
    expect(isDeadSessionAuthError(new Error('Refresh Token Not Found'))).toBe(true);
  });

  test('an expired access token is NOT a death verdict — the refresh token may still be alive (KRTX-2111)', () => {
    expect(
      isDeadSessionAuthError(new Error('Invalid JWT: token is expired (expired at 1700000000)')),
    ).toBe(false);
  });

  test('the no-Authorization transport verdict is not a death verdict (KRTX-1693)', () => {
    expect(
      isDeadSessionAuthError(
        Object.assign(new Error('This endpoint requires a valid Bearer token'), {
          code: 'no_authorization',
        }),
      ),
    ).toBe(false);
  });

  test('anything without a death code or refresh-token message is not a death verdict', () => {
    expect(isDeadSessionAuthError(new Error('network down'))).toBe(false);
    expect(isDeadSessionAuthError(null)).toBe(false);
  });
});
