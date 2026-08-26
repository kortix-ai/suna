// Headless regular auth: /v1/auth/* translates to GoTrue server-side with the
// API's own key and the caller's IP, passes GoTrue's errors through, rate
// limits per IP, and the PKCE social flow keeps the verifier on the client.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

mock.module('../config', () => ({
  config: { SUPABASE_URL: 'http://supabase.internal:8000', SUPABASE_SERVICE_ROLE_KEY: 'service-role-jwt', FRONTEND_URL: 'https://app.example' },
}));
mock.module('../shared/auth-audit', () => ({
  auditLoginFail: () => {},
  auditLoginSuccess: () => {},
  auditLogout: () => {},
  auditSessionFirstSight: () => {},
}));

const gotrueModule = await import('../auth/gotrue');
const { headlessAuthRouter } = await import('../auth/headless');

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];
let respond: (s: Seen) => Response = () => Response.json({});

gotrueModule.__setGoTrueFetch(async (input, init) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  const s: Seen = { url: input, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : null };
  seen.push(s);
  return respond(s);
});

const SESSION = { access_token: 'sb_at', refresh_token: 'sb_rt', token_type: 'bearer', expires_in: 3600, expires_at: 1790000000, user: { id: 'u1', email: 'a@b.test' } };

function app() {
  const a = new Hono();
  a.route('/v1/auth', headlessAuthRouter);
  a.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return a;
}
const post = (path: string, body: unknown, ip = '203.0.113.7') =>
  app().request(`/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  seen = [];
  respond = () => Response.json(SESSION);
});

describe('/v1/auth headless routes', () => {
  test('password sign-in → GoTrue /token?grant_type=password with the service key as apikey, the client IP forwarded, and the session returned', async () => {
    const res = await post('/sign-in/password', { email: 'A@B.test', password: 'hunter22' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: { access_token: 'sb_at', refresh_token: 'sb_rt', token_type: 'bearer', expires_in: 3600, expires_at: 1790000000 }, user: { id: 'u1', email: 'a@b.test' } });
    expect(seen[0].url).toBe('http://supabase.internal:8000/auth/v1/token?grant_type=password');
    expect(seen[0].headers.apikey).toBe('service-role-jwt');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(seen[0].body).toEqual({ email: 'a@b.test', password: 'hunter22' });
  });

  test("GoTrue's error shapes are normalised and its status is passed through", async () => {
    respond = () => Response.json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, { status: 400 });
    const res = await post('/sign-in/password', { email: 'a@b.test', password: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_credentials', error_description: 'Invalid login credentials' });
    respond = () => Response.json({ error: 'invalid_grant', error_description: 'Refresh Token Not Found' }, { status: 400 });
    const r2 = await post('/refresh', { refresh_token: 'dead' });
    expect(await r2.json()).toEqual({ error: 'invalid_grant', error_description: 'Refresh Token Not Found' });
  });

  test('signup reports requires_email_confirmation when GoTrue returns a bare user', async () => {
    respond = () => Response.json({ id: 'u2', email: 'new@b.test', confirmation_sent_at: 'now' });
    const res = await post('/signup', { email: 'new@b.test', password: 'hunter22', redirect_to: 'https://app.example/welcome' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requires_email_confirmation: true, session: null, user: { id: 'u2' } });
    expect(seen[0].url).toBe('http://supabase.internal:8000/auth/v1/signup?redirect_to=https%3A%2F%2Fapp.example%2Fwelcome');
    respond = () => Response.json(SESSION);
    const auto = await post('/signup', { email: 'new2@b.test', password: 'hunter22' });
    expect((await auto.json()).requires_email_confirmation).toBe(false);
  });

  test('magic link, otp verify and password reset hit /otp, /verify, /recover; reset never reveals an unknown address', async () => {
    respond = () => Response.json({});
    expect(await (await post('/sign-in/magic-link', { email: 'a@b.test', redirect_to: 'https://app.example/cb' })).json()).toEqual({ sent: true });
    expect(seen[0].url).toBe('http://supabase.internal:8000/auth/v1/otp?redirect_to=https%3A%2F%2Fapp.example%2Fcb');
    expect(seen[0].body).toEqual({ email: 'a@b.test', create_user: true, data: {} });
    respond = () => Response.json(SESSION);
    const v = await post('/verify-otp', { email: 'a@b.test', token: '123456', type: 'magiclink' });
    expect(v.status).toBe(200);
    expect(seen[1].url).toBe('http://supabase.internal:8000/auth/v1/verify');
    expect(seen[1].body).toEqual({ email: 'a@b.test', token: '123456', type: 'magiclink' });
    respond = () => Response.json({ code: 404, msg: 'User not found' }, { status: 404 });
    const reset = await post('/password/reset', { email: 'ghost@b.test' });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ sent: true });
    expect(seen[2].url).toBe('http://supabase.internal:8000/auth/v1/recover');
  });

  test('social sign-in: PKCE challenge goes to /authorize, the provider URL and the verifier come back, exchange uses grant_type=pkce', async () => {
    respond = (s) =>
      s.url.includes('/authorize')
        ? new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/auth?state=x' } })
        : Response.json(SESSION);
    const start = await post('/sign-in/oauth', { provider: 'google', redirect_to: 'https://app.example/auth/callback' });
    expect(start.status).toBe(200);
    const { url, code_verifier } = await start.json();
    expect(url).toBe('https://accounts.google.com/o/oauth2/auth?state=x');
    const authorize = new URL(seen[0].url);
    expect(authorize.pathname).toBe('/auth/v1/authorize');
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('redirect_to')).toBe('https://app.example/auth/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(authorize.searchParams.get('code_challenge')).toBe(createHash('sha256').update(code_verifier).digest('base64url'));

    const ex = await post('/oauth/exchange', { code: 'abc', code_verifier });
    expect(ex.status).toBe(200);
    expect(seen[1].url).toBe('http://supabase.internal:8000/auth/v1/token?grant_type=pkce');
    expect(seen[1].body).toEqual({ auth_code: 'abc', code_verifier });
  });

  test('a non-http redirect_to is refused before reaching GoTrue; a bad email is a 400 from validation', async () => {
    const res = await post('/sign-in/oauth', { provider: 'github', redirect_to: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
    const bad = await post('/sign-in/password', { email: 'not-an-email', password: 'x' });
    expect(bad.status).toBe(400);
  });

  test('per-IP rate limit: the 31st attempt in a minute is 429 with retry-after, another IP is unaffected', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 31; i += 1) last = await post('/sign-in/password', { email: 'a@b.test', password: 'x' }, '198.51.100.9');
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toBeTruthy();
    expect((await last!.json()).error).toBe('over_request_rate_limit');
    const other = await post('/sign-in/password', { email: 'a@b.test', password: 'x' }, '198.51.100.10');
    expect(other.status).toBe(200);
  });
});
