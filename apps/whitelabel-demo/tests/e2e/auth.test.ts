/**
 * Wrapper-mode demo auth (`src/server/auth.ts` + `/api/auth/*`): login,
 * bad-credential paths, `/api/auth/me` via both bearer and cookie, logout,
 * and tampered/expired tokens.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, resetUsersStore, startApp, uniqueEmail } from './harness';
import { DEMO_PASSWORD, SESSION_SECRET, wrapperEnv } from './env';
import { expiredToken, tamperedToken } from './session-crypto';

function cookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  const m = setCookieHeader.match(new RegExp(`${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

describe('wrapper-mode auth', () => {
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    app = await startApp(wrapperEnv());
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    resetUsersStore();
  });

  test('login happy path: returns a bearer token and sets an HttpOnly cookie', async () => {
    const email = uniqueEmail('happy');
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; userId: string };
    expect(typeof data.token).toBe('string');
    expect(data.token.split('.')).toHaveLength(2);
    expect(data.userId).toBe(email.toLowerCase());

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('lumen_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(cookieValue(setCookie, 'lumen_session')).toBe(data.token);
  });

  test('login with wrong password (DEMO_PASSWORD set) is rejected', async () => {
    const email = uniqueEmail('wrongpw');
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'definitely-not-it' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
  });

  test('login with a malformed email is rejected', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: DEMO_PASSWORD }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
  });

  test('login with an empty password is rejected', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail('nopass'), password: '' }),
    });
    expect(res.status).toBe(401);
  });

  test('GET /api/auth/me via Authorization: Bearer', async () => {
    const email = uniqueEmail('me-bearer');
    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
    const { token } = (await login.json()) as { token: string };

    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: email.toLowerCase() });
  });

  test('GET /api/auth/me via the lumen_session cookie (no bearer header)', async () => {
    const email = uniqueEmail('me-cookie');
    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
    const setCookie = login.headers.get('set-cookie');
    const token = cookieValue(setCookie, 'lumen_session');
    expect(token).toBeTruthy();

    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { cookie: `lumen_session=${encodeURIComponent(token!)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: email.toLowerCase() });
  });

  test('GET /api/auth/me with no credentials at all is 401', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  test('logout clears the session cookie', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('lumen_session=;');
    expect(setCookie).toContain('Max-Age=0');
  });

  test('a tampered session token is rejected (401)', async () => {
    const bad = tamperedToken(SESSION_SECRET, uniqueEmail('tampered'));
    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${bad}` },
    });
    expect(res.status).toBe(401);
  });

  test('an expired (but validly signed) session token is rejected (401)', async () => {
    const expired = expiredToken(SESSION_SECRET, uniqueEmail('expired'));
    const res = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
  });
});
