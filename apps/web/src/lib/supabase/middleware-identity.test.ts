import { describe, expect, test } from 'bun:test';

import { resolveMiddlewareIdentity, type MiddlewareAuth } from './middleware-identity';

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

describe('resolveMiddlewareIdentity', () => {
  test('a locally verified JWT settles the identity without calling getUser', async () => {
    const { auth, calls } = fakeAuth({
      getClaims: async () => ({
        data: { claims: { sub: 'user-123', user_metadata: { locale: 'de' } } },
        error: null,
      }),
      getUser: async () => {
        throw new Error('getUser must not be called on the verified fast path');
      },
    });

    const identity = await resolveMiddlewareIdentity(auth);

    expect(identity.user).toEqual({ id: 'user-123', user_metadata: { locale: 'de' } });
    expect(identity.authError).toBeNull();
    expect(identity.source).toBe('claims');
    expect(calls.filter((c) => c === 'getUser')).toHaveLength(0);
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
