/**
 * `createKortixAuth` — "Sign in with Kortix" for a standalone wrapper app.
 *
 * The whole browser ↔ app ↔ Kortix flow is driven here against a fake Kortix
 * (a `fetch` stub that plays /oauth/token, /oauth/revoke, /accounts/me and one
 * API route). No framework: the kit speaks Web `Request`/`Response` only.
 */
import { test, expect, beforeEach, describe } from 'bun:test';
import { createKortixAuth, KortixAuthError, type KortixAuth, type KortixFetch } from './auth';

const BACKEND = 'https://api.kortix.test/v1';
const CLIENT_ID = '00000000-0000-4000-a000-000000000201';
const SECRET = 'kortix_ocs_test_secret';
const APP = 'https://dash.test';
const REDIRECT = `${APP}/api/kortix/auth/callback`;
const COOKIE_SECRET = 'a-cookie-secret-that-is-at-least-32-chars-long';

type Call = { url: string; method: string; body: Record<string, string> | null; auth: string | null };
let calls: Call[] = [];
let issuedCodes = new Map<string, string>(); // code → code_challenge expected
let tokenCounter = 0;
let revokedTokens: string[] = [];
let identityFor: Record<string, { user_id: string; email: string }> = {};

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
}

/** The fake Kortix API. */
const fakeFetch: KortixFetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const form = text && req.headers.get('content-type')?.includes('form') ? Object.fromEntries(new URLSearchParams(text)) : null;
  calls.push({ url: req.url, method: req.method, body: form, auth: req.headers.get('authorization') });

  if (url.pathname === '/v1/oauth/token') {
    if (form!.client_secret !== SECRET) return Response.json({ error: 'invalid_client' }, { status: 401 });
    if (form!.grant_type === 'authorization_code') {
      const expected = issuedCodes.get(form!.code);
      if (!expected) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if ((await sha256b64url(form!.code_verifier)) !== expected) return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 });
      if (form!.redirect_uri !== REDIRECT) return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
      issuedCodes.delete(form!.code);
    } else if (form!.grant_type === 'refresh_token') {
      if (!form!.refresh_token.startsWith('kortix_ort_') || revokedTokens.includes(form!.refresh_token)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      revokedTokens.push(form!.refresh_token);
    } else {
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    tokenCounter += 1;
    const at = `kortix_oat_${tokenCounter}`;
    identityFor[at] = { user_id: 'user-1', email: 'alice@example.test' };
    return Response.json({ access_token: at, refresh_token: `kortix_ort_${tokenCounter}`, token_type: 'Bearer', expires_in: 3600, scope: 'profile email kortix' });
  }
  if (url.pathname === '/v1/oauth/revoke') {
    // Kortix revokes the PAIR: a refresh token takes its access token with it.
    revokedTokens.push(form!.token);
    delete identityFor[form!.token.replace('kortix_ort_', 'kortix_oat_')];
    return Response.json({ revoked: true });
  }
  if (url.pathname === '/v1/accounts/me') {
    const token = req.headers.get('authorization')?.slice(7) ?? '';
    const id = identityFor[token];
    if (!id) return Response.json({ error: 'Invalid OAuth access token' }, { status: 401 });
    return Response.json({ ...id, token_context: { auth_type: 'oauth' }, accounts: [{ account_id: 'acct-1', slug: 'acct1', name: 'Acme', role: 'member' }] });
  }
  if (url.pathname === '/v1/projects') {
    const token = req.headers.get('authorization')?.slice(7) ?? '';
    if (!identityFor[token]) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    return Response.json([{ project_id: 'p-1', name: 'Dashboards' }]);
  }
  return Response.json({ error: `unhandled ${url.pathname}` }, { status: 404 });
};

function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, ...value] = pair.split('=');
    out[name.trim()] = value.join('=');
  }
  return out;
}
function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function makeAuth(overrides: Partial<Parameters<typeof createKortixAuth>[0]> = {}): KortixAuth {
  return createKortixAuth({
    backendUrl: BACKEND,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    cookieSecret: COOKIE_SECRET,
    fetch: fakeFetch,
    ...overrides,
  });
}

/** Browser: GET /signin, follow the redirect to Kortix, "approve", come back. */
async function signIn(auth: KortixAuth, returnTo = '/reports/weekly') {
  const jar: Record<string, string> = {};
  const start = await auth.handler(new Request(`${APP}/api/kortix/auth/signin?return_to=${encodeURIComponent(returnTo)}`));
  expect(start.status).toBe(302);
  Object.assign(jar, cookiesFrom(start));
  const authorize = new URL(start.headers.get('location')!);
  // Kortix would show consent here; the fake mints a code bound to the challenge.
  const code = `code_${Math.random().toString(36).slice(2)}`;
  issuedCodes.set(code, authorize.searchParams.get('code_challenge')!);
  const cb = new URL(REDIRECT);
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', authorize.searchParams.get('state')!);
  const callback = await auth.handler(new Request(cb.toString(), { headers: { cookie: cookieHeader(jar) } }));
  Object.assign(jar, cookiesFrom(callback));
  return { authorize, callback, jar };
}

beforeEach(() => {
  calls = [];
  issuedCodes = new Map();
  tokenCounter = 0;
  revokedTokens = [];
  identityFor = {};
});

describe('createKortixAuth — configuration', () => {
  test('rejects a short cookie secret and a relative redirect URI up front', () => {
    expect(() => makeAuth({ cookieSecret: 'short' })).toThrow(KortixAuthError);
    expect(() => makeAuth({ redirectUri: '/api/kortix/auth/callback' })).toThrow(KortixAuthError);
  });

  test('derives the base path from the redirect URI and exposes link + browser config', () => {
    const auth = makeAuth();
    expect(auth.basePath).toBe('/api/kortix/auth');
    expect(auth.signInUrl('/x?y=1')).toBe('/api/kortix/auth/signin?return_to=%2Fx%3Fy%3D1');
    expect(auth.signOutUrl()).toBe('/api/kortix/auth/signout');
    const cfg = auth.clientConfig('https://dash.test');
    expect(cfg.backendUrl).toBe('https://dash.test/api/kortix/auth/proxy');
    // A sentinel: the proxy replaces it with the viewer's real token.
    expect(cfg.getToken()).resolves.toBe('kortix-session');
  });
});

describe('createKortixAuth — the sign-in flow', () => {
  test('/signin redirects to Kortix with PKCE S256, state, scopes and the registered redirect_uri', async () => {
    const auth = makeAuth();
    const res = await auth.handler(new Request(`${APP}/api/kortix/auth/signin?return_to=/reports`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${BACKEND}/oauth/authorize`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(location.searchParams.get('scope')).toBe('profile email kortix');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')!.length).toBeGreaterThan(40);
    expect(location.searchParams.get('state')!.length).toBeGreaterThan(20);
    const jar = cookiesFrom(res);
    const txnName = Object.keys(jar).find((k) => k.includes('kortix_oauth'))!;
    expect(txnName).toBeTruthy();
    const raw = res.headers.getSetCookie().find((l) => l.startsWith(txnName))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Lax');
    // The verifier never leaves the server in the clear.
    expect(raw).not.toContain(location.searchParams.get('code_challenge')!);
  });

  test('/callback exchanges the code (with the verifier + secret), sets the session cookie, redirects to return_to', async () => {
    const auth = makeAuth();
    const { callback, jar } = await signIn(auth, '/reports/weekly');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/reports/weekly');
    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(tokenCall.body).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: REDIRECT });
    expect(tokenCall.body!.code_verifier.length).toBeGreaterThan(40);
    const session = jar['__Host-kortix_session'];
    expect(session).toBeTruthy();
    expect(session).not.toContain('kortix_oat_'); // encrypted, not readable
    // The transaction cookie is cleared.
    const txn = callback.headers.getSetCookie().find((l) => l.includes('kortix_oauth_txn'))!;
    expect(txn).toContain('Max-Age=0');
  });

  test('viewer(), /me and kortix() all see the signed-in user; the browser proxy forwards as that user', async () => {
    const auth = makeAuth();
    const { jar } = await signIn(auth);
    const req = (path: string, init: RequestInit = {}) => new Request(`${APP}${path}`, { ...init, headers: { cookie: cookieHeader(jar), ...(init.headers ?? {}) } });

    const viewer = await auth.viewer(req('/reports'));
    expect(viewer).toMatchObject({ userId: 'user-1', email: 'alice@example.test', scopes: ['profile', 'email', 'kortix'] });
    expect(viewer!.token).toBe('kortix_oat_1');
    expect(viewer!.accounts[0]).toMatchObject({ account_id: 'acct-1', role: 'member' });

    const me = await auth.handler(req('/api/kortix/auth/me'));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user_id: 'user-1', email: 'alice@example.test', accounts: [{ account_id: 'acct-1' }] });

    const kortix = await auth.kortix(req('/reports'));
    const projects = await kortix.projects.list();
    expect(projects as unknown).toEqual([{ project_id: 'p-1', name: 'Dashboards' }]);
    expect(calls.at(-1)!.auth).toBe('Bearer kortix_oat_1');

    const proxied = await auth.handler(req('/api/kortix/auth/proxy/projects?limit=5', { headers: { authorization: 'Bearer kortix-session' } }));
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toEqual([{ project_id: 'p-1', name: 'Dashboards' }]);
    const forwarded = calls.at(-1)!;
    expect(forwarded.url).toBe(`${BACKEND}/projects?limit=5`);
    expect(forwarded.auth).toBe('Bearer kortix_oat_1');
  });

  test('without a session: viewer() is null, /me is 401, proxy is 401, kortix() throws, requireViewer redirects to /signin', async () => {
    const auth = makeAuth();
    const req = new Request(`${APP}/reports/weekly?x=1`);
    expect(await auth.viewer(req)).toBeNull();
    expect((await auth.handler(new Request(`${APP}/api/kortix/auth/me`))).status).toBe(401);
    expect((await auth.handler(new Request(`${APP}/api/kortix/auth/proxy/projects`))).status).toBe(401);
    await expect(auth.kortix(req)).rejects.toBeInstanceOf(KortixAuthError);
    const gate = await auth.requireViewer(req);
    expect(gate.viewer).toBeUndefined();
    expect(gate.response!.status).toBe(302);
    expect(gate.response!.headers.get('location')).toBe('/api/kortix/auth/signin?return_to=%2Freports%2Fweekly%3Fx%3D1');
  });
});

describe('createKortixAuth — expiry, refresh, sign-out, abuse', () => {
  test('an expired access token: viewer() is null, requireViewer redirects to /refresh, /refresh rotates and sets a new cookie', async () => {
    const auth = makeAuth({ now: () => Date.parse('2026-08-26T10:00:00Z') });
    const { jar } = await signIn(auth);
    // Move the clock past the 1h access lifetime.
    (auth as unknown as { __setNow: (f: () => number) => void }).__setNow(() => Date.parse('2026-08-26T11:30:00Z'));
    const req = new Request(`${APP}/reports`, { headers: { cookie: cookieHeader(jar) } });
    expect(await auth.viewer(req)).toBeNull();
    const gate = await auth.requireViewer(req);
    expect(gate.response!.headers.get('location')).toBe('/api/kortix/auth/refresh?return_to=%2Freports');

    const refreshed = await auth.handler(new Request(`${APP}/api/kortix/auth/refresh?return_to=/reports`, { headers: { cookie: cookieHeader(jar) } }));
    expect(refreshed.status).toBe(302);
    expect(refreshed.headers.get('location')).toBe('/reports');
    const tokenCall = calls.filter((c) => c.url.endsWith('/oauth/token')).at(-1)!;
    expect(tokenCall.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'kortix_ort_1', client_id: CLIENT_ID, client_secret: SECRET });
    Object.assign(jar, cookiesFrom(refreshed));
    const viewer = await auth.viewer(new Request(`${APP}/reports`, { headers: { cookie: cookieHeader(jar) } }));
    expect(viewer!.token).toBe('kortix_oat_2');
  });

  test('/me and /proxy refresh inline when the access token expired, and persist the rotated pair', async () => {
    const auth = makeAuth({ now: () => Date.parse('2026-08-26T10:00:00Z') });
    const { jar } = await signIn(auth);
    (auth as unknown as { __setNow: (f: () => number) => void }).__setNow(() => Date.parse('2026-08-26T11:30:00Z'));
    const me = await auth.handler(new Request(`${APP}/api/kortix/auth/me`, { headers: { cookie: cookieHeader(jar) } }));
    expect(me.status).toBe(200);
    expect(cookiesFrom(me)['__Host-kortix_session']).toBeTruthy();
    Object.assign(jar, cookiesFrom(me));
    expect((await auth.viewer(new Request(`${APP}/x`, { headers: { cookie: cookieHeader(jar) } })))!.token).toBe('kortix_oat_2');
  });

  test('a dead refresh token clears the session and sends the user to /signin', async () => {
    const auth = makeAuth({ now: () => Date.parse('2026-08-26T10:00:00Z') });
    const { jar } = await signIn(auth);
    revokedTokens.push('kortix_ort_1');
    (auth as unknown as { __setNow: (f: () => number) => void }).__setNow(() => Date.parse('2026-08-26T11:30:00Z'));
    const res = await auth.handler(new Request(`${APP}/api/kortix/auth/refresh?return_to=/reports`, { headers: { cookie: cookieHeader(jar) } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/api/kortix/auth/signin?return_to=%2Freports');
    expect(res.headers.getSetCookie().find((l) => l.startsWith('__Host-kortix_session'))).toContain('Max-Age=0');
  });

  test('/signout revokes the refresh token at Kortix and clears the cookie', async () => {
    const auth = makeAuth();
    const { jar } = await signIn(auth);
    const res = await auth.handler(new Request(`${APP}/api/kortix/auth/signout?return_to=/bye`, { method: 'POST', headers: { cookie: cookieHeader(jar) } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/bye');
    expect(res.headers.getSetCookie().find((l) => l.startsWith('__Host-kortix_session'))).toContain('Max-Age=0');
    const revoke = calls.find((c) => c.url.endsWith('/oauth/revoke'))!;
    expect(revoke.body).toMatchObject({ token: 'kortix_ort_1', client_id: CLIENT_ID, client_secret: SECRET });
    expect(await auth.viewer(new Request(`${APP}/x`, { headers: { cookie: cookieHeader(jar) } }))).toBeNull();
  });

  test('state mismatch, a forged callback without the transaction cookie, and a tampered cookie are all refused', async () => {
    const auth = makeAuth();
    const start = await auth.handler(new Request(`${APP}/api/kortix/auth/signin`));
    const jar = cookiesFrom(start);
    issuedCodes.set('c1', new URL(start.headers.get('location')!).searchParams.get('code_challenge')!);
    const wrongState = await auth.handler(new Request(`${REDIRECT}?code=c1&state=nope`, { headers: { cookie: cookieHeader(jar) } }));
    expect(wrongState.status).toBe(400);
    expect((await wrongState.json()).error).toBe('state_mismatch');
    const noCookie = await auth.handler(new Request(`${REDIRECT}?code=c1&state=${new URL(start.headers.get('location')!).searchParams.get('state')}`));
    expect(noCookie.status).toBe(400);
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);

    const { jar: signed } = await signIn(auth);
    const tampered = { ...signed, '__Host-kortix_session': signed['__Host-kortix_session'].slice(0, -4) + 'AAAA' };
    expect(await auth.viewer(new Request(`${APP}/x`, { headers: { cookie: cookieHeader(tampered) } }))).toBeNull();
  });

  test('user denial at Kortix comes back as a redirect with kortix_auth_error, never a token call', async () => {
    const auth = makeAuth();
    const start = await auth.handler(new Request(`${APP}/api/kortix/auth/signin?return_to=/reports`));
    const jar = cookiesFrom(start);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await auth.handler(new Request(`${REDIRECT}?error=access_denied&state=${state}`, { headers: { cookie: cookieHeader(jar) } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/reports?kortix_auth_error=access_denied');
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
  });

  test('return_to is confined to a same-origin path', async () => {
    const auth = makeAuth();
    for (const bad of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)', '/\\evil.test']) {
      const { callback } = await signIn(auth, bad);
      expect(callback.headers.get('location')).toBe('/');
    }
  });

  test('a public client sends no client_secret', async () => {
    const auth = makeAuth({ clientSecret: undefined });
    // The fake insists on the secret; a public client is refused there — what
    // matters is what the kit SENT.
    await signIn(auth).catch(() => {});
    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(tokenCall.body).not.toHaveProperty('client_secret');
    expect(tokenCall.body).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID });
  });

  test('http redirect URI (local dev) uses a non-__Host- cookie without Secure', async () => {
    const auth = makeAuth({ redirectUri: 'http://localhost:3200/api/kortix/auth/callback' });
    const start = await auth.handler(new Request('http://localhost:3200/api/kortix/auth/signin'));
    const raw = start.headers.getSetCookie()[0];
    expect(raw.startsWith('kortix_oauth_txn=')).toBe(true);
    expect(raw).not.toContain('Secure');
  });
});
