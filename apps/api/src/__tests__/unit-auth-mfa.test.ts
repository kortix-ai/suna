/**
 * `/v1/auth/mfa/*` — headless MFA, the last thing forcing apps/web to hold a
 * Supabase client for authentication.
 *
 * MFA is not decoration here: `accounts.mfa_required` is a real column and
 * `authorize()` step 6 denies a browser session that is not `aal2`. So the
 * capability has to MOVE, not be dropped, even though no account currently
 * enables it — deleting the enrolment surface while the server still denies
 * would lock an account out with no way back.
 *
 * Every route forwards to GoTrue with the CALLER's bearer. The service-role key
 * would let any signed-in user enroll or unenroll a factor on someone else's
 * account, which is the whole threat model of a second factor.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../config', () => ({
  config: { SUPABASE_URL: 'http://supabase.internal:8000', SUPABASE_SERVICE_ROLE_KEY: 'service-role-jwt', FRONTEND_URL: 'https://app.example' },
}));
mock.module('../shared/auth-audit', () => ({
  auditLoginFail: () => {}, auditLoginSuccess: () => {}, auditLogout: () => {}, auditSessionFirstSight: () => {},
}));
mock.module('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const gotrueModule = await import('../auth/gotrue');
const { authRouter } = await import('../auth');

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];
let respond: () => Response = () => Response.json({ id: 'f1' });

gotrueModule.__setGoTrueFetch(async (input, init) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  seen.push({ url: input, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : null });
  return respond();
});

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

function req(path: string, init: RequestInit = {}, token = 'sb_at', authType = 'supabase') {
  return app(authType).request(`/v1/auth${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

beforeEach(() => { seen = []; respond = () => Response.json({ id: 'f1' }); });

describe('/v1/auth/mfa', () => {
  test('enroll posts to GoTrue /factors as the caller', async () => {
    const response = await req('/mfa/factors', { method: 'POST', body: JSON.stringify({ factor_type: 'totp', friendly_name: 'Phone' }) });
    expect(response.status).toBe(200);
    const call = seen.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/factors');
    expect(call.body).toEqual({ factor_type: 'totp', friendly_name: 'Phone' });
    expect(call.headers.authorization).toBe('Bearer sb_at');
  });

  test('challenge and verify address one factor by id', async () => {
    await req('/mfa/factors/f1/challenge', { method: 'POST', body: JSON.stringify({}) });
    expect(seen.at(-1)!.url).toContain('/factors/f1/challenge');

    await req('/mfa/factors/f1/verify', { method: 'POST', body: JSON.stringify({ challenge_id: 'c1', code: '123456' }) });
    const verify = seen.at(-1)!;
    expect(verify.url).toContain('/factors/f1/verify');
    expect(verify.body).toEqual({ challenge_id: 'c1', code: '123456' });
  });

  test('unenroll deletes the factor', async () => {
    const response = await req('/mfa/factors/f1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const call = seen.at(-1)!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toContain('/factors/f1');
  });

  test('every route needs a Supabase session bearer, never a PAT', async () => {
    // A PAT has no second factor to step up with, and MFA enrolment under a
    // long-lived machine credential would defeat the point of a second factor.
    for (const [path, init] of [
      ['/mfa/factors', { method: 'POST', body: JSON.stringify({ factor_type: 'totp' }) }],
      ['/mfa/factors/f1/challenge', { method: 'POST', body: JSON.stringify({}) }],
      ['/mfa/factors/f1', { method: 'DELETE' }],
    ] as const) {
      const response = await req(path, init as RequestInit, 'kortix_pat_x', 'api_key');
      expect(response.status, path).toBe(401);
    }
    expect(seen.length).toBe(0);
  });

  test('a GoTrue refusal is passed through, not reported as success', async () => {
    respond = () => Response.json({ error: 'invalid_code', error_description: 'wrong code' }, { status: 422 });
    const response = await req('/mfa/factors/f1/verify', { method: 'POST', body: JSON.stringify({ challenge_id: 'c1', code: '000000' }) });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('invalid_code');
  });
});
