import { describe, expect, test } from 'bun:test';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { gateNavigationFetch, sessionCookieNeedsRefresh } from './navigation-session-gate';

const ORIGIN = 'https://app.example.test';
const NOW = 1_800_000_000_000;

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The session cookie as `@supabase/ssr` writes it, for a token that expires `inSeconds` from NOW. */
function sessionCookie(inSeconds: number, encoding: 'base64' | 'json' | 'chunked' = 'base64'): string {
  const json = JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: Math.floor(NOW / 1000) + inSeconds,
  });
  if (encoding === 'json') return `${KORTIX_SUPABASE_AUTH_COOKIE}=${encodeURIComponent(json)}`;
  const value = `base64-${base64Url(json)}`;
  if (encoding === 'base64') return `theme=dark; ${KORTIX_SUPABASE_AUTH_COOKIE}=${value}`;
  const half = Math.ceil(value.length / 2);
  return `${KORTIX_SUPABASE_AUTH_COOKIE}.0=${value.slice(0, half)}; ${KORTIX_SUPABASE_AUTH_COOKIE}.1=${value.slice(half)}`;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued promise callback run. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A response the browser reached by following a redirect to `url`. */
function redirectedTo(url: string, body = 'flight'): Response {
  const response = new Response(body, { headers: { 'content-type': 'text/x-component' } });
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function harness(cookie: string, respond: () => Response = () => new Response('ok')) {
  const sent: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const refreshes: Deferred[] = [];
  const waits: Deferred[] = [];
  let cookieNow = cookie;
  const gated = gateNavigationFetch(
    (input, init) => {
      sent.push({ input, init });
      return Promise.resolve(respond());
    },
    {
      origin: ORIGIN,
      now: () => NOW,
      readCookie: () => cookieNow,
      refresh: () => {
        const next = deferred();
        refreshes.push(next);
        return next.promise;
      },
      wait: () => {
        const next = deferred();
        waits.push(next);
        return next.promise;
      },
    },
  );
  return {
    gated,
    sent,
    refreshes,
    waits,
    setCookie(value: string) {
      cookieNow = value;
    },
  };
}

const RSC = { headers: { RSC: '1', 'Next-Router-State-Tree': '%5B%5D' } };

describe('sessionCookieNeedsRefresh', () => {
  test('matches the middleware margin, refreshed early enough to absorb clock skew', () => {
    expect(sessionCookieNeedsRefresh(sessionCookie(-30), NOW)).toBe(true);
    expect(sessionCookieNeedsRefresh(sessionCookie(60), NOW)).toBe(true);
    // The middleware calls 100 s fresh. A client clock 10 s behind the server would not.
    expect(sessionCookieNeedsRefresh(sessionCookie(100), NOW)).toBe(true);
    expect(sessionCookieNeedsRefresh(sessionCookie(200), NOW)).toBe(false);
    expect(sessionCookieNeedsRefresh(sessionCookie(3600), NOW)).toBe(false);
  });

  test('reads every cookie shape @supabase/ssr writes', () => {
    expect(sessionCookieNeedsRefresh(sessionCookie(60, 'json'), NOW)).toBe(true);
    expect(sessionCookieNeedsRefresh(sessionCookie(60, 'chunked'), NOW)).toBe(true);
    expect(sessionCookieNeedsRefresh(sessionCookie(3600, 'chunked'), NOW)).toBe(false);
  });

  test('no session, or an unreadable one, is never a reason to wait', () => {
    expect(sessionCookieNeedsRefresh('', NOW)).toBe(false);
    expect(sessionCookieNeedsRefresh('theme=dark', NOW)).toBe(false);
    expect(sessionCookieNeedsRefresh(`${KORTIX_SUPABASE_AUTH_COOKIE}=base64-%%%`, NOW)).toBe(false);
    expect(sessionCookieNeedsRefresh(`${KORTIX_SUPABASE_AUTH_COOKIE}=${encodeURIComponent('{"expires_at":"soon"}')}`, NOW)).toBe(false);
  });
});

describe('gateNavigationFetch', () => {
  test('a navigation with a stale session goes out only after the refresh', async () => {
    const h = harness(sessionCookie(30));
    const response = h.gated(new URL('/projects/p1?_rsc=abc', ORIGIN), RSC);
    await settle();
    expect(h.refreshes).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    h.refreshes[0].resolve();
    expect(await (await response).text()).toBe('ok');
    expect(h.sent).toHaveLength(1);
    expect(String(h.sent[0].input)).toBe(`${ORIGIN}/projects/p1?_rsc=abc`);
    expect(h.sent[0].init).toBe(RSC);
  });

  test('a burst of prefetches shares one refresh', async () => {
    const h = harness(sessionCookie(-600));
    const all = [
      h.gated(`${ORIGIN}/projects/p1`, RSC),
      h.gated('/projects/p2', { headers: new Headers({ rsc: '1', 'next-router-prefetch': '1' }) }),
      h.gated(new Request(`${ORIGIN}/projects/p3`, { headers: { RSC: '1' } })),
    ];
    await settle();
    expect(h.refreshes).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    h.refreshes[0].resolve();
    await Promise.all(all);
    expect(h.sent).toHaveLength(3);
  });

  test('a server action waits like a navigation', async () => {
    const h = harness(sessionCookie(30));
    const action = h.gated('', { method: 'POST', headers: [['Next-Action', 'abc123']] });
    await settle();
    expect(h.refreshes).toHaveLength(1);
    h.refreshes[0].resolve();
    await action;
    expect(h.sent).toHaveLength(1);
  });

  test('a fresh session, no session, other requests and other origins go straight out', async () => {
    const fresh = harness(sessionCookie(3600));
    await fresh.gated('/projects/p1', RSC);
    expect(fresh.refreshes).toHaveLength(0);

    const signedOut = harness('theme=dark');
    await signedOut.gated('/projects/p1', RSC);
    expect(signedOut.refreshes).toHaveLength(0);

    const stale = harness(sessionCookie(30));
    await stale.gated('/v1/projects', { headers: { Authorization: 'Bearer x' } });
    await stale.gated('https://api.example.test/projects/p1', RSC);
    await stale.gated(new URL('/projects/p1', ORIGIN));
    expect(stale.refreshes).toHaveLength(0);
    expect(stale.sent).toHaveLength(3);
  });

  test('a refresh that hangs releases the navigation after the wait', async () => {
    const h = harness(sessionCookie(30));
    const navigation = h.gated('/projects/p1', RSC);
    await settle();
    expect(h.waits).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    h.waits[0].resolve();
    await navigation;
    expect(h.sent).toHaveLength(1);
    // The refresh still in flight is the one the next navigation waits on.
    const next = h.gated('/projects/p2', RSC);
    await settle();
    expect(h.refreshes).toHaveLength(1);
    h.refreshes[0].resolve();
    await next;
    expect(h.sent).toHaveLength(2);
  });

  test('a refresh that fails releases the navigation at once, and the next stale navigation tries again', async () => {
    const h = harness(sessionCookie(30));
    const first = h.gated('/projects/p1', RSC);
    await settle();
    h.refreshes[0].reject(new Error('network down'));
    await first;
    expect(h.sent).toHaveLength(1);

    const second = h.gated('/projects/p2', RSC);
    await settle();
    expect(h.refreshes).toHaveLength(2);
    h.refreshes[1].resolve();
    await second;
    expect(h.sent).toHaveLength(2);
  });

  test('a session refreshed by another tab is not refreshed again', async () => {
    const h = harness(sessionCookie(30));
    h.setCookie(sessionCookie(3600));
    await h.gated('/projects/p1', RSC);
    expect(h.refreshes).toHaveLength(0);
  });
});

describe('a bounce to sign-in never reaches the router cache', () => {
  const bounce = `${ORIGIN}/auth?redirect=%2Fprojects%2Fp1`;

  test('an RSC response the middleware sent to /auth arrives as a failed response at the /auth URL', async () => {
    const h = harness(sessionCookie(3600), () => redirectedTo(bounce));
    const response = await h.gated(new URL('/projects/p1?_rsc=abc', ORIGIN), RSC);
    // Not OK and not Flight: a navigation loads /auth as a document, a prefetch is not cached.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(response.redirected).toBe(false);
    expect(response.url).toBe(bounce);
    expect(response.headers.get('content-type')).not.toContain('text/x-component');
  });

  test('other redirects, and redirects of other requests, arrive unchanged', async () => {
    const elsewhere = redirectedTo(`${ORIGIN}/projects/p2`);
    const moved = harness(sessionCookie(3600), () => elsewhere);
    expect(await moved.gated('/projects/p1', RSC)).toBe(elsewhere);

    const plainAuth = redirectedTo(`${ORIGIN}/auth`);
    const noReturn = harness(sessionCookie(3600), () => plainAuth);
    expect(await noReturn.gated('/projects/p1', RSC)).toBe(plainAuth);

    const actionBounce = redirectedTo(bounce);
    const action = harness(sessionCookie(3600), () => actionBounce);
    expect(await action.gated('', { method: 'POST', headers: { 'Next-Action': 'abc' } })).toBe(actionBounce);

    const documentBounce = redirectedTo(bounce);
    const plain = harness(sessionCookie(3600), () => documentBounce);
    expect(await plain.gated('/projects/p1')).toBe(documentBounce);
  });
});
