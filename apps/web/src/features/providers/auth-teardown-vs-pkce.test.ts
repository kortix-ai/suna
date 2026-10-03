import { describe, expect, test } from 'bun:test';
import { createServerClient } from '@supabase/ssr';

/**
 * The dead-session teardown destroys a pending magic-link flow.
 *
 * Root cause of the prod report (2026-10-03): a fresh emailed sign-in link
 * bounced to `/auth?expired=true` with no session. The browser held a session
 * whose account was gone; AuthProvider's bootstrap calls `getUser()`, GoTrue
 * answers 403 `session_not_found`, auth-js turns that into
 * `AuthSessionMissingError` and tears the session down — and the teardown
 * (`removeAllPKCEVerifiers`) deletes EVERY stored PKCE verifier, including one
 * a sign-in submitted moments earlier had just written. The emailed link then
 * exchanges with no verifier: auth-js fails locally with
 * `AuthPKCECodeVerifierMissingError` (HTTP status 400), which the callback
 * route classifies as an expired link.
 *
 * Both tests run the REAL @supabase/ssr server client (real PKCE cookie
 * mechanics, real auth-js) against a fake GoTrue that answers the way prod's
 * did: `/user` 403 `session_not_found` for the dead session, `/otp` and
 * `/token` enforcing the code-challenge binding. The ordering they assert is
 * the invariant the /auth submit gate enforces: the bootstrap must settle
 * before a sign-in flow starts.
 */

const GOTRUE_URL = 'https://gotrue.test';
const STORAGE_KEY = 'sb-kortix-auth-token';
const WEB_ORIGIN = 'https://dev.kortix.test';

type JarCookie = { name: string; value: string; options?: Record<string, unknown> };

function base64Url(value: string): string {
  return btoa(String(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function makeHarness() {
  const jar = new Map<string, JarCookie>();
  let userVerdict: number = 403;
  let userDelayMs = 0;
  let challenge: string | null = null;

  async function fakeGotrue(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/user')) {
      if (userDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, userDelayMs));
      return Response.json(
        { code: 403, error_code: 'session_not_found', msg: 'Session not found' },
        { status: userVerdict },
      );
    }
    if (url.pathname.endsWith('/otp')) {
      challenge = JSON.parse(String(init?.body)).code_challenge as string;
      return Response.json({}, { status: 200 });
    }
    if (url.pathname.endsWith('/token')) {
      const body = JSON.parse(String(init?.body));
      const hashed = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(String(body.code_verifier)),
      );
      const matches =
        typeof challenge === 'string' &&
        btoa(String.fromCharCode(...new Uint8Array(hashed)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '') === challenge;
      if (!matches) {
        return Response.json(
          { error: 'invalid_grant', error_description: 'code challenge mismatch' },
          { status: 400 },
        );
      }
      return Response.json(
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          user: {
            id: '11111111-1111-1111-1111-111111111111',
            email: 'synthetic@example.test',
            created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            app_metadata: { provider: 'email' },
            user_metadata: {},
          },
        },
        { status: 200 },
      );
    }
    return Response.json({ msg: 'not found' }, { status: 404 });
  }

  const makeClient = () =>
    createServerClient(GOTRUE_URL, 'anon-key', {
      cookieOptions: { name: STORAGE_KEY, path: '/', sameSite: 'lax' },
      cookies: {
        getAll: () => [...jar.values()],
        setAll: (list: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
          for (const cookie of list) {
            if (cookie.value) jar.set(cookie.name, cookie);
            else jar.delete(cookie.name);
          }
        },
      },
      global: { fetch: fakeGotrue },
    });

  // The browser state the report started from: a session GoTrue will
  // definitively reject (its account was deleted), still locally valid.
  const seedDeletedSession = () => {
    const session = {
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: '22222222-2222-2222-2222-222222222222', email: 'synthetic@example.test' },
    };
    jar.set(STORAGE_KEY, {
      name: STORAGE_KEY,
      value: `base64-${base64Url(JSON.stringify(session))}`,
    });
  };

  const verifierCookieNames = () =>
    [...jar.keys()].filter(
      (name) => name.startsWith(STORAGE_KEY) && name.endsWith('-code-verifier'),
    );

  // Storage writes ride on auth events, which apply asynchronously after the
  // awaited call resolves.
  const settleStorage = () => new Promise((resolve) => setTimeout(resolve, 25));

  return { jar, makeClient, seedDeletedSession, verifierCookieNames, settleStorage, setUserDelay: (ms: number) => { userDelayMs = ms; } };
}

describe('a dead-session teardown versus a pending magic-link flow', () => {
  test('teardown resolving after the sign-in request deletes the fresh verifier — the link then fails as expired', async () => {
    const { jar, makeClient, seedDeletedSession, verifierCookieNames, settleStorage, setUserDelay } =
      makeHarness();
    seedDeletedSession();
    const client = makeClient();

    // The bootstrap starts validating the stale session and does not answer
    // within this turn (slow auth server) — the /auth form is already usable.
    setUserDelay(75);
    const bootstrap = client.auth.getUser();

    // The visitor submits the form; the send-email action stores the flow's
    // verifier cookies.
    const { error: otpError } = await client.auth.signInWithOtp({
      email: 'synthetic@example.test',
      options: { emailRedirectTo: `${WEB_ORIGIN}/auth/callback?returnUrl=/projects` },
    });
    expect(otpError).toBeNull();
    expect(verifierCookieNames().length).toBeGreaterThan(0);

    // The bootstrap's verdict arrives: the session is gone. auth-js tears the
    // session down and removes every stored PKCE verifier with it.
    const { error: userError } = await bootstrap;
    expect(userError?.message).toContain('session');
    await settleStorage();

    expect(verifierCookieNames()).toEqual([]);

    // The emailed link arrives and the callback exchanges it: no verifier in
    // storage, auth-js fails locally with a 400 — the input to the route's
    // "expired link" classification, and exactly the reported bounce.
    const { data, error } = await client.auth.exchangeCodeForSession('auth-code');
    expect(data.session).toBeNull();
    expect(error).not.toBeNull();
    expect((error as { status?: number }).status).toBe(400);
    expect(jar.size >= 0).toBe(true);
  });

  test('the bootstrap settles first — the fresh link exchanges and creates a session', async () => {
    const { jar, makeClient, seedDeletedSession, verifierCookieNames, settleStorage } = makeHarness();
    seedDeletedSession();
    const client = makeClient();

    // The gate's ordering: the bootstrap's verdict resolves BEFORE any
    // sign-in starts, so its teardown has nothing pending to destroy.
    const { error: userError } = await client.auth.getUser();
    expect(userError?.message).toContain('session');
    expect(verifierCookieNames()).toEqual([]);

    const { error: otpError } = await client.auth.signInWithOtp({
      email: 'synthetic@example.test',
      options: { emailRedirectTo: `${WEB_ORIGIN}/auth/callback?returnUrl=/projects` },
    });
    expect(otpError).toBeNull();
    const verifiers = verifierCookieNames();
    expect(verifiers.length).toBeGreaterThan(0);

    // The emailed link opens and the callback exchanges the code.
    const { data, error } = await client.auth.exchangeCodeForSession('auth-code');
    expect(error).toBeNull();
    expect(data.session?.access_token).toBe('access-token');
    await settleStorage();
    // A fresh magic link creates a session — the acceptance outcome.
    expect(
      [...jar.keys()].some(
        (name) => name === STORAGE_KEY || name.startsWith(`${STORAGE_KEY}.`),
      ),
    ).toBe(true);
  });
});
