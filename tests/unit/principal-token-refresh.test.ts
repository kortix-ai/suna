/**
 * A password-grant principal keeps a valid Supabase access token for the whole
 * run.
 *
 * Preview runs 36067774228 and 36068206735 (2026-09-24) ran for ~61 minutes.
 * The runner minted each principal's JWT once at world setup and never renewed
 * it, so every flow that started after the 60-minute mark failed with
 * `401 Invalid or expired token`. These tests drive the real `Client` against a
 * fake Supabase token endpoint and a fake API, with a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, isKe2eRetryableError, transientBreaker } from '../src/core/client';
import type { Env } from '../src/core/env';
import {
  SupabaseSessionAuth,
  SupabaseSessionRefreshError,
  resolveRefreshMarginMs,
  type RefreshTimer,
} from '../src/fixtures/supabase-session';
import { passwordGrantSession, refreshGrant } from '../src/fixtures/supabase';
import { synthUserWithEmail } from '../src/fixtures/principals';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SUPABASE = 'https://supabase.ke2e.test';
const API = 'https://api.ke2e.test/v1';

const env = {
  supabaseUrl: SUPABASE,
  supabaseAnonKey: 'anon-key',
  supabaseServiceRoleKey: 'service-role-key',
  apiUrl: API,
} as unknown as Env;

interface Call {
  kind: 'refresh' | 'password' | 'admin-create' | 'api';
  authorization?: string;
  refreshToken?: string;
  apikey?: string;
}

/** Fake Supabase auth + fake API. Every refresh rotates both tokens. */
function fakeBackend(opts: { refreshStatus?: number; refreshNetworkError?: boolean } = {}) {
  const calls: Call[] = [];
  let generation = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin === SUPABASE && url.pathname === '/auth/v1/token') {
      const grantType = url.searchParams.get('grant_type');
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string };
      if (grantType === 'refresh_token') {
        calls.push({ kind: 'refresh', refreshToken: body.refresh_token, apikey: headers.get('apikey') ?? undefined });
        if (opts.refreshNetworkError) throw new TypeError('fetch failed');
        if (opts.refreshStatus && opts.refreshStatus !== 200) {
          return new Response(
            JSON.stringify({ code: opts.refreshStatus, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }),
            { status: opts.refreshStatus, headers: { 'content-type': 'application/json' } },
          );
        }
      } else {
        calls.push({ kind: 'password', apikey: headers.get('apikey') ?? undefined });
      }
      generation += 1;
      return Response.json({
        access_token: `access-${generation}`,
        refresh_token: `refresh-${generation}`,
        expires_in: 3600,
        token_type: 'bearer',
      });
    }
    if (url.origin === SUPABASE && url.pathname === '/auth/v1/admin/users') {
      calls.push({ kind: 'admin-create' });
      return Response.json({ id: 'user-1', email: 'owner@ke2e.test' });
    }
    calls.push({ kind: 'api', authorization: headers.get('authorization') ?? undefined });
    return Response.json({ ok: true }, { headers: { 'x-request-id': 'r' } });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { calls, fetchImpl };
}

/** A clock the test moves by hand. */
function fakeClock(start = Date.UTC(2026, 8, 24, 22, 36)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function session(clock: ReturnType<typeof fakeClock>, overrides: Partial<ConstructorParameters<typeof SupabaseSessionAuth>[0]> = {}) {
  return new SupabaseSessionAuth({
    label: 'OWNER',
    grant: { accessToken: 'access-0', refreshToken: 'refresh-0', expiresInMs: HOUR },
    refresh: (refreshToken) => refreshGrant(env, refreshToken),
    now: clock.now,
    timer: null,
    ...overrides,
  });
}

beforeEach(() => {
  transientBreaker.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  transientBreaker.reset();
});

describe('principal Supabase session refresh', () => {
  it('refreshes a 59-minute-old token before the next request and sends the new token', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    clock.advance(59 * MINUTE);
    await client.get('/v1/accounts');

    expect(calls.map((c) => c.kind)).toEqual(['refresh', 'api']);
    expect(calls[0]?.refreshToken).toBe('refresh-0');
    expect(calls[0]?.apikey).toBe('anon-key');
    expect(calls[1]?.authorization).toBe('Bearer access-1');
    expect(auth.token).toBe('access-1');
  });

  it('keeps a 30-minute-old token and sends it without a refresh', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    clock.advance(30 * MINUTE);
    await client.get('/v1/accounts');

    expect(calls.map((c) => c.kind)).toEqual(['api']);
    expect(calls[0]?.authorization).toBe('Bearer access-0');
  });

  it('keeps a principal valid across a 3-hour run by rotating the refresh token', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    for (let minute = 0; minute < 180; minute += 5) {
      await client.get('/v1/accounts');
      clock.advance(5 * MINUTE);
    }

    const refreshes = calls.filter((c) => c.kind === 'refresh');
    // Renewed every ~40 min (20-min margin on a 60-min token): 4 times in 3 h.
    expect(refreshes.map((c) => c.refreshToken)).toEqual(['refresh-0', 'refresh-1', 'refresh-2', 'refresh-3']);
    expect(auth.expiresAt - clock.now()).toBeGreaterThan(20 * MINUTE);
  });

  it('shares one refresh between concurrent requests', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    clock.advance(59 * MINUTE);
    await Promise.all(Array.from({ length: 6 }, () => client.get('/v1/accounts')));

    expect(calls.filter((c) => c.kind === 'refresh')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'api').map((c) => c.authorization)).toEqual(
      Array(6).fill('Bearer access-1'),
    );
  });

  it('fails with a clear error and sends nothing when the token expired and refresh is refused', async () => {
    const { calls } = fakeBackend({ refreshStatus: 400 });
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    clock.advance(61 * MINUTE);
    const error = await client.get('/v1/accounts').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(SupabaseSessionRefreshError);
    const message = String((error as Error).message);
    expect(message).toMatch(/OWNER/);
    expect(message).toMatch(/refresh/i);
    expect(message).toMatch(/400/);
    expect(message).toMatch(/expired 1m ago/);
    expect(message).not.toMatch(/refresh-0|access-0/);
    expect(isKe2eRetryableError(error)).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(['refresh']);
  });

  it('marks a network failure of the refresh as retryable infrastructure', async () => {
    fakeBackend({ refreshNetworkError: true });
    const clock = fakeClock();
    const auth = session(clock);

    clock.advance(61 * MINUTE);
    const error = await auth.ensureFresh().then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(SupabaseSessionRefreshError);
    expect(isKe2eRetryableError(error)).toBe(true);
  });

  it('keeps using a still-valid token when refresh fails, and backs off before trying again', async () => {
    const { calls } = fakeBackend({ refreshStatus: 503 });
    const clock = fakeClock();
    const auth = session(clock);
    const client = new Client(API).as({ label: 'OWNER', auth });

    clock.advance(50 * MINUTE);
    await client.get('/v1/accounts');
    await client.get('/v1/accounts');

    expect(calls.map((c) => c.kind)).toEqual(['refresh', 'api', 'api']);
    expect(calls[1]?.authorization).toBe('Bearer access-0');

    clock.advance(31_000);
    await client.get('/v1/accounts');
    expect(calls.filter((c) => c.kind === 'refresh')).toHaveLength(2);
  });

  it('renews in the background so a synchronous `.token` read stays valid', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const timer: RefreshTimer = {
      set: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      clear: () => undefined,
    };
    const auth = session(clock, { timer });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(40 * MINUTE);

    clock.advance(40 * MINUTE);
    scheduled[0]?.fn();
    await vi.waitFor(() => expect(auth.token).toBe('access-1'));

    expect(calls.map((c) => c.kind)).toEqual(['refresh']);
    expect(scheduled).toHaveLength(2);
    auth.stop();
  });

  it('never schedules background renewals back to back, even when the margin covers the whole lifetime', async () => {
    const { calls } = fakeBackend();
    const clock = fakeClock();
    const scheduled: number[] = [];
    const pending: Array<() => void> = [];
    const timer: RefreshTimer = {
      set: (fn, ms) => {
        scheduled.push(ms);
        pending.push(fn);
        return scheduled.length;
      },
      clear: () => undefined,
    };
    const auth = session(clock, { timer, marginMs: 2 * HOUR });

    pending.shift()?.();
    await vi.waitFor(() => expect(auth.token).toBe('access-1'));

    expect(scheduled).toEqual([30_000, 30_000]);
    expect(calls.filter((c) => c.kind === 'refresh')).toHaveLength(1);
    auth.stop();
  });

  it('never serializes the refresh token or the access token', () => {
    fakeBackend();
    const auth = session(fakeClock());

    const json = JSON.stringify({ label: 'OWNER', auth });

    expect(json).not.toContain('refresh-0');
    expect(json).not.toContain('access-0');
    expect(json).toContain('"mode":"bearer"');
  });

  it('defaults the refresh margin to 20 min, or half of a shorter token lifetime', () => {
    expect(resolveRefreshMarginMs(HOUR, {})).toBe(20 * MINUTE);
    expect(resolveRefreshMarginMs(10 * MINUTE, {})).toBe(5 * MINUTE);
    expect(resolveRefreshMarginMs(HOUR, { KE2E_TOKEN_REFRESH_MARGIN_MS: '300000' })).toBe(5 * MINUTE);
    expect(resolveRefreshMarginMs(HOUR, { KE2E_TOKEN_REFRESH_MARGIN_MS: 'soon' })).toBe(20 * MINUTE);
  });
});

describe('Supabase grant parsing', () => {
  it('returns the access token, the refresh token, and the lifetime from a password grant', async () => {
    const { calls } = fakeBackend();

    const grant = await passwordGrantSession(env, 'owner@ke2e.test', 'pw');

    expect(grant).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresInMs: HOUR });
    expect(calls.map((c) => c.kind)).toEqual(['password']);
  });

  it('refuses a token response with no refresh token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'a', expires_in: 3600 })));

    await expect(passwordGrantSession(env, 'owner@ke2e.test', 'pw')).rejects.toThrow(/refresh_token/);
  });
});

describe('synthesized principals', () => {
  it('carry a self-refreshing bearer credential', async () => {
    const { calls } = fakeBackend();

    const synth = await synthUserWithEmail(env, 'owner@ke2e.test', 'OWNER');
    synth.session.stop();

    expect(synth.principal.auth).toBe(synth.session);
    expect(synth.principal.auth.mode).toBe('bearer');
    expect((synth.principal.auth as { token: string }).token).toBe('access-1');
    expect(calls.map((c) => c.kind)).toEqual(['admin-create', 'password']);
  });
});
