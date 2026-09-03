/**
 * `PATCH /v1/auth/user` — the headless replacement for `supabase.auth.updateUser({ data })`.
 *
 * Six of the eight `updateUser` call sites in apps/web write nothing but user
 * METADATA: display name, avatar URL, language. They are ordinary profile
 * writes with no session semantics, and they were the last thing forcing those
 * files to hold a Supabase client. This route is what lets them stop.
 *
 * It is deliberately metadata-only. `password` and `email` changes are
 * credential changes with their own flows (`/password/update`, GoTrue's email
 * confirmation), and quietly accepting them here would give one route two very
 * different blast radii.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../config', () => ({
  config: { SUPABASE_URL: 'http://supabase.internal:8000', SUPABASE_SERVICE_ROLE_KEY: 'service-role-jwt', FRONTEND_URL: 'https://app.example' },
}));
mock.module('../shared/auth-audit', () => ({
  auditLoginFail: () => {},
  auditLoginSuccess: () => {},
  auditLogout: () => {},
  auditSessionFirstSight: () => {},
}));
mock.module('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const gotrueModule = await import('../auth/gotrue');
const { authRouter } = await import('../auth');

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];
let respond: () => Response = () => Response.json({ id: 'u1', user_metadata: { name: 'New Name' } });

gotrueModule.__setGoTrueFetch(async (input, init) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  seen.push({ url: input, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : null });
  return respond();
});

/** Mounts the router with the auth context a supabase-bearer request would carry. */
function app(authType = 'supabase') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('authType' as never, authType as never);
    c.set('userId' as never, 'u1' as never);
    await next();
  });
  a.route('/v1/auth', authRouter as never);
  return a;
}

function patch(body: unknown, token = 'sb_at', authType = 'supabase') {
  return app(authType).request('/v1/auth/user', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  seen = [];
  respond = () => Response.json({ id: 'u1', user_metadata: { name: 'New Name' } });
});

describe('PATCH /v1/auth/user', () => {
  test('forwards metadata to GoTrue as the CALLER, not the service role', async () => {
    const response = await patch({ data: { name: 'New Name' } });
    expect(response.status).toBe(200);

    const call = seen.at(-1)!;
    expect(call.method).toBe('PUT');
    expect(call.url).toContain('/user');
    expect(call.body).toEqual({ data: { name: 'New Name' } });
    // The caller's own bearer. Using the service-role key here would let any
    // signed-in user edit any other user by id.
    expect(call.headers.authorization).toBe('Bearer sb_at');

    expect(await response.json()).toEqual({ user: { id: 'u1', user_metadata: { name: 'New Name' } } });
  });

  test('refuses a credential change dressed as metadata', async () => {
    // `password` and `email` are not profile fields. They have their own flows,
    // and accepting them here would give one route two blast radii.
    for (const body of [{ data: { name: 'x' }, password: 'hunter2hunter2' }, { data: {}, email: 'new@b.test' }]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
      expect(seen.length).toBe(0);
    }
  });

  test('needs a Supabase session bearer, not a PAT', async () => {
    const response = await patch({ data: { name: 'x' } }, 'kortix_pat_abc', 'api_key');
    expect(response.status).toBe(401);
    expect(seen.length).toBe(0);
  });

  test('passes a GoTrue failure through rather than reporting success', async () => {
    respond = () => Response.json({ error: 'over_request_rate_limit', error_description: 'slow down' }, { status: 429 });
    const response = await patch({ data: { name: 'x' } });
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('over_request_rate_limit');
  });
});
