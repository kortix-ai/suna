import { beforeEach, describe, expect, test } from 'bun:test';

import { createKortix } from '../client/kortix';
import { createKortixAuth, createKortixAuthWithDeps } from './client';
import type { KortixAuthChange } from './client';
import { KortixAuthError } from './errors';
import { createMemoryAuthStorage, serializeStoredSession, type KortixAuthStorage } from './storage';
import type { KortixAuthSession } from './session';
import type { KortixAuthConfig } from './config';

// ── fixtures ────────────────────────────────────────────────────────────────

const CONFIG: KortixAuthConfig = {
  provider: 'supabase',
  url: 'https://supa.kortix.test',
  anonKey: 'anon-key-1',
  methods: ['magic', 'password'],
  providers: ['google'],
  signupsEnabled: true,
};

const STORAGE_KEY = 'kortix.auth.session';

function jwt(expSecondsFromNow: number, subject = 'u1'): string {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${encode(JSON.stringify({ alg: 'HS256' }))}.${encode(JSON.stringify({ sub: subject, exp }))}.sig`;
}

function session(accessToken: string, refreshToken = 'refresh-1'): KortixAuthSession {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'u1', email: 'a@b.test' },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch stub that routes by URL, records every call, and fails loudly on an
 *  unexpected route rather than returning a silent 200. */
function harness() {
  const calls: Call[] = [];
  const routes: Array<{ match: (url: string) => boolean; respond: (call: Call) => Response }> = [];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(call.url));
    if (!route) return Response.json({ error: `unrouted ${call.url}` }, { status: 599 });
    return route.respond(call);
  };

  return {
    calls,
    fetchImpl,
    on(fragment: string, respond: (call: Call) => Response) {
      routes.push({ match: (url) => url.includes(fragment), respond });
      return this;
    },
    callsTo(fragment: string) {
      return calls.filter((call) => call.url.includes(fragment));
    },
  };
}

const sleeps: number[] = [];
const recordSleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(() => {
  sleeps.length = 0;
});

/** An auth client wired to a storage + fetch harness, with discovery skipped
 *  unless a test explicitly exercises it. */
function makeAuth(
  overrides: {
    storage?: KortixAuthStorage;
    fetchImpl?: typeof fetch | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
    onError?: (error: unknown) => void;
    config?: KortixAuthConfig | undefined;
    tokenCacheTtlMs?: number;
  } = {},
) {
  const storage = overrides.storage ?? createMemoryAuthStorage();
  // `config: undefined` is how a test asks for REAL discovery; omitting the key
  // gets the fixture. `'config' in overrides` is the only way to tell those
  // apart — `?? CONFIG` silently hands the fixture to both.
  const config = 'config' in overrides ? overrides.config : CONFIG;
  return {
    storage,
    auth: createKortixAuthWithDeps(
      {
        backendUrl: 'https://api.kortix.test/v1',
        ...(config ? { config } : {}),
        storage,
        fetch: overrides.fetchImpl as never,
        ...(overrides.onError ? { onError: overrides.onError } : {}),
        ...(overrides.tokenCacheTtlMs === undefined
          ? {}
          : { tokenCacheTtlMs: overrides.tokenCacheTtlMs }),
      },
      { sleep: recordSleep },
    ),
  };
}

async function seed(storage: KortixAuthStorage, value: KortixAuthSession): Promise<void> {
  await storage.setItem(STORAGE_KEY, serializeStoredSession(CONFIG.url, value));
}

// ── construction ────────────────────────────────────────────────────────────

describe('construction', () => {
  test('creates no timer — the module is inert in a worker, a lambda, and a test', () => {
    // Refresh is lazy, driven by getToken. Nothing is scheduled, so there is no
    // dispose() to forget and no handle keeping a process alive.
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    let timers = 0;
    globalThis.setTimeout = ((...args: unknown[]) => {
      timers++;
      return (realSetTimeout as unknown as (...a: unknown[]) => number)(...args);
    }) as unknown as typeof setTimeout;
    globalThis.setInterval = ((...args: unknown[]) => {
      timers++;
      return (realSetInterval as unknown as (...a: unknown[]) => number)(...args);
    }) as unknown as typeof setInterval;
    try {
      createKortixAuth({ backendUrl: 'https://api.kortix.test/v1', config: CONFIG });
      expect(timers).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
    }
  });

  test('performs no I/O at construction', async () => {
    const http = harness();
    makeAuth({ fetchImpl: http.fetchImpl });
    await Promise.resolve();
    expect(http.calls).toHaveLength(0);
  });
});

// ── getToken: cache + single flight ─────────────────────────────────────────

describe('getToken cache and single flight', () => {
  test('a second call inside the TTL issues no further request', async () => {
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ access_token: jwt(3600), refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(-10)));

    const first = await auth.getToken();
    const second = await auth.getToken();

    expect(first).toBe(second as string);
    expect(http.callsTo('grant_type=refresh_token')).toHaveLength(1);
  });

  test('five concurrent cold callers produce EXACTLY one refresh request', async () => {
    // SSE, the health check, the session fetch, … all race for a token on page
    // load. Without single-flight each one starts its own refresh chain.
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ access_token: jwt(3600), refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(-10)));

    const tokens = await Promise.all([
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(http.callsTo('grant_type=refresh_token')).toHaveLength(1);
  });

  test('a stored, live access_token is adopted with zero network calls', async () => {
    const http = harness();
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    const live = jwt(3600);
    await seed(storage, session(live));

    expect(await auth.getToken()).toBe(live);
    expect(http.calls).toHaveLength(0);
  });

  test('returns null when nothing is stored', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    expect(await auth.getToken()).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

// ── the bug this module exists to fix ───────────────────────────────────────

describe('a stored-but-expired access_token', () => {
  test('is refreshed, and the dead token is NEVER returned', async () => {
    // supabase-js `getSession()` returns the STORED session even when its
    // access_token has already expired — it does not refresh. Handing that dead
    // token out produces a 401; on a surface with no 401 recovery (the PTY
    // WebSocket) that becomes an endless 1006 reconnect loop.
    // apps/web/src/lib/auth-token.ts:164-177.
    const dead = jwt(-60);
    const fresh = jwt(3600);
    const http = harness().on('grant_type=refresh_token', (call) => {
      expect(call.body).toEqual({ refresh_token: 'refresh-1' });
      return Response.json({ access_token: fresh, refresh_token: 'refresh-2', expires_in: 3600 });
    });
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(dead));

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    const token = await auth.getToken();

    expect(token).toBe(fresh);
    expect(token).not.toBe(dead);
    expect(events.map((event) => event.event)).toContain('TOKEN_REFRESHED');
    // The refreshed session is persisted, so a reload does not repeat the round trip.
    const raw = (await storage.getItem(STORAGE_KEY)) as string;
    expect(JSON.parse(raw).session.access_token).toBe(fresh);
    expect(JSON.parse(raw).session.refresh_token).toBe('refresh-2');
  });

  test('is refreshed when it is merely INSIDE the 30 s expiry skew', async () => {
    const nearlyDead = jwt(20);
    const fresh = jwt(3600);
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(nearlyDead));

    expect(await auth.getToken()).toBe(fresh);
  });
});

// ── server rejection vs network failure ─────────────────────────────────────

describe('refresh failure handling', () => {
  test('a 400 invalid_grant clears storage, emits SIGNED_OUT, and returns null WITHOUT throwing', async () => {
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }, { status: 400 }),
    );
    const errors: unknown[] = [];
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl, onError: (e) => void errors.push(e) });
    await seed(storage, session(jwt(-60)));

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    // getToken is the seam authenticatedFetch calls; a throw here would escape
    // into every caller. null is the shape the seam already handles (it becomes
    // a synthetic 401 in core/http/auth.ts:176-178).
    const token = await auth.getToken();

    expect(token).toBeNull();
    expect(await storage.getItem(STORAGE_KEY)).toBeNull();
    expect(auth.getSession()).toBeNull();
    expect(events.map((event) => event.event)).toContain('SIGNED_OUT');
    expect(errors).toHaveLength(0);
  });

  test('a network failure retries twice at 300/600 ms, then returns the last-known un-expired token', async () => {
    // A flaky network must NOT sign a user out. The token is inside the skew
    // (so refresh was attempted) but not yet past exp, so it is still usable.
    const usable = jwt(20);
    const http = harness().on('grant_type=refresh_token', () => {
      throw new TypeError('Failed to fetch');
    });
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(usable));

    const token = await auth.getToken();

    expect(token).toBe(usable);
    expect(http.callsTo('grant_type=refresh_token')).toHaveLength(3); // 1 + 2 retries
    expect(sleeps).toEqual([300, 600]);
    // Storage is untouched: the server never said no.
    expect(await storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  test('a 5xx is a network failure, not a rejection — the session survives', async () => {
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ error: 'internal' }, { status: 503 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(20)));

    await auth.getToken();

    expect(http.callsTo('grant_type=refresh_token')).toHaveLength(3);
    expect(await storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  test('a network failure with a token already past exp returns null and keeps the session', async () => {
    const http = harness().on('grant_type=refresh_token', () => {
      throw new TypeError('Failed to fetch');
    });
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(-60)));

    expect(await auth.getToken()).toBeNull();
    expect(await storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  test('getToken never throws when discovery itself fails — it reports through onError', async () => {
    const http = harness().on('/auth/config', () => new Response('nope', { status: 500 }));
    const errors: unknown[] = [];
    const { auth } = makeAuth({
      fetchImpl: http.fetchImpl,
      config: undefined,
      onError: (error) => void errors.push(error),
    });

    expect(await auth.getToken()).toBeNull();
    expect(errors[0]).toBeInstanceOf(KortixAuthError);
  });
});

// ── sign-in ─────────────────────────────────────────────────────────────────

describe('signInWithPassword', () => {
  test('persists the session, emits SIGNED_IN, and the next getToken does no I/O', async () => {
    const fresh = jwt(3600);
    const http = harness().on('grant_type=password', () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'u1' } }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    const result = await auth.signInWithPassword({ email: 'a@b.test', password: 'pw' });

    expect(result.access_token).toBe(fresh);
    expect(auth.getSession()?.access_token).toBe(fresh);
    const raw = (await storage.getItem(STORAGE_KEY)) as string;
    expect(JSON.parse(raw)).toMatchObject({ v: 1, url: CONFIG.url });
    expect(events.map((event) => event.event)).toContain('SIGNED_IN');

    const before = http.calls.length;
    expect(await auth.getToken()).toBe(fresh);
    expect(http.calls).toHaveLength(before);
  });

  test('propagates a 400 invalid_credentials as a KortixAuthError with .code', async () => {
    const http = harness().on('grant_type=password', () =>
      Response.json({ error_code: 'invalid_credentials', error_description: 'Invalid login credentials' }, { status: 400 }),
    );
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });

    const error = (await auth
      .signInWithPassword({ email: 'a@b.test', password: 'wrong' })
      .catch((caught: unknown) => caught)) as KortixAuthError;

    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.code).toBe('invalid_credentials');
    expect(auth.getSession()).toBeNull();
  });
});

describe('signInWithOtp', () => {
  test('resolves void, puts redirect_to in the query, and defaults create_user to true', async () => {
    const http = harness().on('/auth/v1/otp', () => Response.json({}));
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });

    const result = await auth.signInWithOtp({
      email: 'a@b.test',
      redirectTo: 'https://app.test/callback',
    });

    expect(result).toBeUndefined();
    const call = http.callsTo('/auth/v1/otp')[0];
    expect(call?.url).toContain(`redirect_to=${encodeURIComponent('https://app.test/callback')}`);
    expect(call?.body).toMatchObject({ email: 'a@b.test', create_user: true });
    // No session exists yet — the user still has to click the link.
    expect(auth.getSession()).toBeNull();
  });
});

describe('verifyOtp', () => {
  test('persists the session and emits SIGNED_IN', async () => {
    const fresh = jwt(3600);
    const http = harness().on('/auth/v1/verify', () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-1', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    const result = await auth.verifyOtp({ email: 'a@b.test', token: '123456' });

    expect(result.access_token).toBe(fresh);
    expect(http.callsTo('/auth/v1/verify')[0]?.body).toMatchObject({ type: 'email' });
    expect(await storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(events.map((event) => event.event)).toContain('SIGNED_IN');
  });

  test('the emailed-link form sends token_hash and persists identically', async () => {
    const fresh = jwt(3600);
    const hash = 'b'.repeat(56);
    const http = harness().on('/auth/v1/verify', () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-1', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    const result = await auth.verifyOtp({ token_hash: hash, type: 'magiclink' });

    expect(result.access_token).toBe(fresh);
    const body = http.callsTo('/auth/v1/verify')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ token_hash: hash, type: 'magiclink' });
    expect(body.email).toBeUndefined();
    expect(body.token).toBeUndefined();
    // Session handling is the password path's, unchanged.
    expect(await storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(auth.getSession()?.access_token).toBe(fresh);
    expect(events.map((event) => event.event)).toContain('SIGNED_IN');
  });
});

// ── sign-out ────────────────────────────────────────────────────────────────

describe('signOut', () => {
  test('clears local state and emits SIGNED_OUT even when the GoTrue call FAILS', async () => {
    // A sign-out that leaves a live token behind because the network blipped is
    // the worst possible outcome — the user believes they are signed out.
    const http = harness().on('/auth/v1/logout', () => {
      throw new TypeError('Failed to fetch');
    });
    const errors: unknown[] = [];
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl, onError: (e) => void errors.push(e) });
    await seed(storage, session(jwt(3600)));
    await auth.getToken();

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    await auth.signOut();

    expect(await storage.getItem(STORAGE_KEY)).toBeNull();
    expect(auth.getSession()).toBeNull();
    expect(await auth.getToken()).toBeNull();
    expect(events.map((event) => event.event)).toContain('SIGNED_OUT');
    expect(errors).toHaveLength(1); // reported, not thrown
  });

  test('calls GoTrue with the live token and the requested scope', async () => {
    const http = harness().on('/auth/v1/logout', () => new Response(null, { status: 204 }));
    const token = jwt(3600);
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(token));
    await auth.getToken();

    await auth.signOut({ scope: 'local' });

    const call = http.callsTo('/auth/v1/logout')[0];
    expect(call?.url).toContain('scope=local');
    expect(call?.headers.get('Authorization')).toBe(`Bearer ${token}`);
  });

  test('is a no-op network-wise when there is no session', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    await auth.signOut();
    expect(http.calls).toHaveLength(0);
  });
});

// ── getUser ─────────────────────────────────────────────────────────────────

describe('getUser', () => {
  test('returns the cached user without a request, and re-reads with force', async () => {
    const http = harness().on('/auth/v1/user', () =>
      Response.json({ id: 'u1', email: 'renamed@b.test' }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(3600)));

    expect((await auth.getUser())?.email).toBe('a@b.test');
    expect(http.callsTo('/auth/v1/user')).toHaveLength(0);

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    expect((await auth.getUser({ force: true }))?.email).toBe('renamed@b.test');
    expect(http.callsTo('/auth/v1/user')).toHaveLength(1);
    expect(events.map((event) => event.event)).toContain('USER_UPDATED');
  });

  test('returns null when there is no usable token', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    expect(await auth.getUser()).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

// ── refresh ─────────────────────────────────────────────────────────────────

describe('refresh', () => {
  test('refreshes regardless of TTL and returns the new session', async () => {
    const fresh = jwt(3600);
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(jwt(3600)));
    await auth.getToken(); // warm the cache with a live token

    const refreshed = await auth.refresh();

    expect(refreshed?.access_token).toBe(fresh);
    expect(http.callsTo('grant_type=refresh_token')).toHaveLength(1);
    expect(await auth.getToken()).toBe(fresh);
  });

  test('returns null when there is nothing to refresh', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    expect(await auth.refresh()).toBeNull();
  });
});

// ── onChange ────────────────────────────────────────────────────────────────

describe('onChange', () => {
  test('delivers INITIAL once per listener with the hydrated session', async () => {
    const http = harness();
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    const token = jwt(3600);
    await seed(storage, session(token));

    const seen: KortixAuthChange[] = [];
    // No public call is awaited in between: registering a listener is enough,
    // so a host never has to special-case "before the first event".
    auth.onChange((change) => void seen.push(change));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe('INITIAL');
    expect(seen[0]?.session?.access_token).toBe(token);
  });

  test('delivers INITIAL with null when nothing is stored', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    const seen: KortixAuthChange[] = [];
    auth.onChange((change) => void seen.push(change));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ event: 'INITIAL', session: null }]);
  });

  test('unsubscribe stops delivery', async () => {
    const fresh = jwt(3600);
    const http = harness().on('grant_type=password', () =>
      Response.json({ access_token: fresh, refresh_token: 'r', expires_in: 3600 }),
    );
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });

    const seen: KortixAuthChange[] = [];
    const unsubscribe = auth.onChange((change) => void seen.push(change));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    await auth.signInWithPassword({ email: 'a@b.test', password: 'pw' });
    expect(seen.map((change) => change.event)).toEqual(['INITIAL']);
  });

  test('a throwing listener is reported and does not break the refresh', async () => {
    const fresh = jwt(3600);
    const http = harness().on('grant_type=refresh_token', () =>
      Response.json({ access_token: fresh, refresh_token: 'r2', expires_in: 3600 }),
    );
    const errors: unknown[] = [];
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl, onError: (e) => void errors.push(e) });
    await seed(storage, session(jwt(-60)));

    auth.onChange(() => {
      throw new Error('listener blew up');
    });
    const good: KortixAuthChange[] = [];
    auth.onChange((change) => void good.push(change));

    expect(await auth.getToken()).toBe(fresh);
    expect(errors.some((error) => (error as Error).message === 'listener blew up')).toBe(true);
    expect(good.map((change) => change.event)).toContain('TOKEN_REFRESHED');
  });
});

describe('syncAcrossTabs', () => {
  /** Install a `window` + `addEventListener` pair and hand back whatever the
   *  client registered, so the opt-in path is exercised rather than asserted. */
  function withFakeWindow(run: (fire: (event: unknown) => void) => Promise<void>): Promise<void> {
    const holder = globalThis as { window?: unknown; addEventListener?: unknown };
    const hadWindow = 'window' in holder;
    const previousWindow = holder.window;
    const previousAdd = holder.addEventListener;
    const handlers: Array<(event: unknown) => void> = [];
    holder.window = {};
    holder.addEventListener = (type: string, handler: (event: unknown) => void) => {
      if (type === 'storage') handlers.push(handler);
    };
    const done = run((event) => handlers.forEach((handler) => handler(event)));
    return done.finally(() => {
      if (hadWindow) holder.window = previousWindow;
      else delete holder.window;
      holder.addEventListener = previousAdd;
    });
  }

  test('is off by default — no listener is registered', async () => {
    await withFakeWindow(async (fire) => {
      const { auth } = makeAuth({ fetchImpl: harness().fetchImpl });
      fire({ key: STORAGE_KEY, newValue: serializeStoredSession(CONFIG.url, session(jwt(3600))) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(auth.getSession()).toBeNull();
    });
  });

  test('when opted in, another tab signing in updates this client and emits', async () => {
    await withFakeWindow(async (fire) => {
      const storage = createMemoryAuthStorage();
      const auth = createKortixAuthWithDeps(
        { backendUrl: 'https://api.kortix.test/v1', config: CONFIG, storage, syncAcrossTabs: true },
        { sleep: recordSleep },
      );
      const events: KortixAuthChange[] = [];
      auth.onChange((change) => void events.push(change));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const token = jwt(3600);
      fire({ key: STORAGE_KEY, newValue: serializeStoredSession(CONFIG.url, session(token)) });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(auth.getSession()?.access_token).toBe(token);
      expect(await auth.getToken()).toBe(token);
      expect(events.map((change) => change.event)).toEqual(['INITIAL', 'TOKEN_REFRESHED']);

      fire({ key: STORAGE_KEY, newValue: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(auth.getSession()).toBeNull();
      expect(events.at(-1)?.event).toBe('SIGNED_OUT');
    });
  });

  test('ignores a storage event for a different key', async () => {
    await withFakeWindow(async (fire) => {
      const auth = createKortixAuthWithDeps(
        { backendUrl: 'https://api.kortix.test/v1', config: CONFIG, syncAcrossTabs: true },
        {},
      );
      fire({ key: 'some.other.key', newValue: 'anything' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(auth.getSession()).toBeNull();
    });
  });
});

// ── discovery ───────────────────────────────────────────────────────────────

describe('config()', () => {
  test('is memoized — two calls issue one request', async () => {
    const http = harness().on('/auth/config', () =>
      Response.json({
        provider: 'supabase',
        url: CONFIG.url,
        anon_key: CONFIG.anonKey,
        methods: ['password'],
        providers: [],
        signups_enabled: false,
      }),
    );
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl, config: undefined });

    const [first, second] = await Promise.all([auth.config(), auth.config()]);

    expect(first.methods).toEqual(['password']);
    expect(first).toEqual(second);
    expect(http.callsTo('/auth/config')).toHaveLength(1);
    expect(await auth.config()).toEqual(first);
    expect(http.callsTo('/auth/config')).toHaveLength(1);
  });

  test('issues zero requests when config is supplied in options', async () => {
    const http = harness();
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl });
    expect(await auth.config()).toEqual(CONFIG);
    expect(http.calls).toHaveLength(0);
  });

  test('a stored blob from a DIFFERENT backend is discarded, not cross-fed', async () => {
    const http = harness();
    const storage = createMemoryAuthStorage();
    await storage.setItem(
      STORAGE_KEY,
      serializeStoredSession('https://supa.other.test', session(jwt(3600))),
    );
    const { auth } = makeAuth({ fetchImpl: http.fetchImpl, storage });

    expect(await auth.getToken()).toBeNull();
    expect(auth.getSession()).toBeNull();
  });
});

// ── the seam ────────────────────────────────────────────────────────────────

describe('the getToken seam', () => {
  test('works UNBOUND — createKortix({ getToken: auth.getToken })', async () => {
    // getToken is an arrow-function property, not a prototype method. If it
    // were a method, this exact line — the one every consumer writes first —
    // would blow up on `this`.
    const token = jwt(3600);
    const http = harness();
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await seed(storage, session(token));

    const bare = auth.getToken;
    expect(await bare()).toBe(token);

    const kortix = createKortix({ backendUrl: 'https://api.kortix.test/v1', getToken: auth.getToken });
    expect(typeof kortix.projects.list).toBe('function');
  });
});

// ── PKCE ────────────────────────────────────────────────────────────────────

describe('PKCE social sign-in', () => {
  test('authorizeUrl throws pkce_unsupported when crypto.subtle is absent — no silent downgrade', async () => {
    // GoTrue accepts code_challenge_method=plain. Falling back to it silently
    // downgrades the flow, so this fails loudly and names the missing API.
    const holder = globalThis as { crypto?: unknown };
    const real = holder.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const { auth } = makeAuth({ fetchImpl: harness().fetchImpl });
      const error = (await auth
        .authorizeUrl('google')
        .catch((caught: unknown) => caught)) as KortixAuthError;
      expect(error).toBeInstanceOf(KortixAuthError);
      expect(error.code).toBe('pkce_unsupported');
      expect(error.message).toContain('crypto.subtle');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });

  test('authorizeUrl uses S256 and persists the verifier', async () => {
    const { auth, storage } = makeAuth({ fetchImpl: harness().fetchImpl });

    const url = new URL(await auth.authorizeUrl('google', { redirectTo: 'https://app.test/cb' }));

    expect(url.origin + url.pathname).toBe('https://supa.kortix.test/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('redirect_to')).toBe('https://app.test/cb');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const verifier = (await storage.getItem(`${STORAGE_KEY}.verifier`)) as string;
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
  });

  test('exchangeCodeForSession sends the stored verifier, persists the session, and clears it', async () => {
    const fresh = jwt(3600);
    const http = harness().on('grant_type=pkce', () =>
      Response.json({ access_token: fresh, refresh_token: 'r', expires_in: 3600 }),
    );
    const { auth, storage } = makeAuth({ fetchImpl: http.fetchImpl });
    await auth.authorizeUrl('google');
    const verifier = (await storage.getItem(`${STORAGE_KEY}.verifier`)) as string;

    const events: KortixAuthChange[] = [];
    auth.onChange((change) => void events.push(change));

    const result = await auth.exchangeCodeForSession('auth-code-1');

    expect(result.access_token).toBe(fresh);
    expect(http.callsTo('grant_type=pkce')[0]?.body).toEqual({
      auth_code: 'auth-code-1',
      code_verifier: verifier,
    });
    expect(await storage.getItem(`${STORAGE_KEY}.verifier`)).toBeNull();
    expect(events.map((event) => event.event)).toContain('SIGNED_IN');
    expect(await auth.getToken()).toBe(fresh);
  });

  test('exchangeCodeForSession without a stored verifier is a typed error', async () => {
    const { auth } = makeAuth({ fetchImpl: harness().fetchImpl });
    const error = (await auth
      .exchangeCodeForSession('auth-code-1')
      .catch((caught: unknown) => caught)) as KortixAuthError;
    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.code).toBe('pkce_verifier_missing');
  });
});
