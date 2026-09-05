import { afterEach, describe, expect, test } from 'bun:test';

import {
  __resetAuthTokenCacheForTests,
  __setFetchTokenForTests,
  getSupabaseAccessToken,
  setBootstrapAuthToken,
  setCachedAuthToken,
} from './auth-token';

/**
 * JAY: the audit's PLAUSIBLE (not CONFIRMED) finding on `auth-token.ts` —
 * `getSupabaseAccessToken()` used to commit `cachedToken = token` after an
 * `await` with no generation check, and `setCachedAuthToken(null)` neither
 * bumped a generation nor cleared `inflight`. A fetch started under one
 * identity that resolved AFTER a later invalidation (a 401, a sign-out) could
 * land its stale answer on top of whatever replaced it. `authEpoch` closes
 * that gap.
 *
 * Uses dependency injection (`__setFetchTokenForTests`), not
 * `mock.module('@/lib/supabase/client', ...)` — a module mock in this repo is
 * process-wide (see `sign-out-sequence.test.ts`), and this file's own state
 * (`cachedToken`, `authEpoch`, `inflight`) is likewise module-level, so every
 * test resets it explicitly.
 */

afterEach(() => {
  __resetAuthTokenCacheForTests();
});

/** A promise this test can resolve/reject on its own schedule. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('getSupabaseAccessToken: stale in-flight fetch vs. a later invalidation', () => {
  test('a fetch that resolves AFTER setCachedAuthToken(null) is discarded — returns null, does not repopulate the cache', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    // Starts the in-flight fetch (nothing cached yet).
    const pending = getSupabaseAccessToken();

    // The identity boundary: something invalidates the cache — e.g. a 401
    // handler, or a sign-out — WHILE the fetch above is still in flight.
    setCachedAuthToken(null);

    // The stale fetch finally resolves, carrying a token for the identity
    // that existed BEFORE the invalidation above.
    fetch.resolve('stale-token-from-before-invalidation');

    await expect(pending).resolves.toBeNull();

    // Prove the cache itself was never repopulated with the stale value —
    // not just that this one call's return value was null. A fresh call
    // must fetch again (hitting the NEW fetchTokenImpl below) rather than
    // fast-pathing on a poisoned `cachedToken`.
    __setFetchTokenForTests(() => Promise.resolve('fresh-token-after-invalidation'));
    await expect(getSupabaseAccessToken()).resolves.toBe('fresh-token-after-invalidation');
  });

  test('control: a fetch that resolves BEFORE any invalidation still commits normally', async () => {
    __resetAuthTokenCacheForTests();
    __setFetchTokenForTests(() => Promise.resolve('normal-token'));

    await expect(getSupabaseAccessToken()).resolves.toBe('normal-token');

    // Cached: a second call must not need another fetch. Swap the
    // implementation to something that would prove a re-fetch happened.
    __setFetchTokenForTests(() => Promise.resolve('should-not-be-seen'));
    await expect(getSupabaseAccessToken()).resolves.toBe('normal-token');
  });

  test('setCachedAuthToken(null) drops the abandoned in-flight promise so the NEXT caller starts its own fetch', async () => {
    __resetAuthTokenCacheForTests();
    const firstFetch = deferred<string | null>();
    __setFetchTokenForTests(() => firstFetch.promise);

    const pending = getSupabaseAccessToken();
    setCachedAuthToken(null);

    // A caller arriving AFTER the invalidation must get a token resolved
    // under the NEW fetch, never a value piggybacked off the abandoned one —
    // even though the abandoned fetch has not resolved yet.
    __setFetchTokenForTests(() => Promise.resolve('second-caller-token'));
    await expect(getSupabaseAccessToken()).resolves.toBe('second-caller-token');

    firstFetch.resolve('first-caller-stale-token');
    await expect(pending).resolves.toBeNull();
  });

  // JAY: CRITICAL regression found by review round 1. `if (inflight) return
  // inflight;` returned the RAW in-flight promise to a piggybacking caller,
  // bypassing the epoch check entirely — only the caller that STARTED the
  // fetch ever ran it. Piggybacking is the module's NORMAL case (the doc
  // comment's "5+ parallel Supabase auth roundtrips" collapsed to one), so
  // this was the common path, not an edge case.
  test('a piggybacking (deduped) caller also gets null on a mid-flight invalidation — not the raw stale token', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const callerA = getSupabaseAccessToken(); // starts the fetch
    const callerB = getSupabaseAccessToken(); // dedupes onto the SAME in-flight fetch

    // The identity boundary lands while BOTH callers are still waiting.
    setCachedAuthToken(null);

    // The shared fetch finally resolves, carrying a token for the identity
    // that existed BEFORE the invalidation above.
    fetch.resolve('stale-token-from-before-invalidation');

    await expect(callerA).resolves.toBeNull();
    await expect(callerB).resolves.toBeNull();
  });

  test('concurrent callers with no invalidation between them still dedupe onto one fetch', async () => {
    __resetAuthTokenCacheForTests();
    let fetchCount = 0;
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => {
      fetchCount += 1;
      return fetch.promise;
    });

    const first = getSupabaseAccessToken();
    const second = getSupabaseAccessToken();
    fetch.resolve('shared-token');

    await expect(first).resolves.toBe('shared-token');
    await expect(second).resolves.toBe('shared-token');
    expect(fetchCount).toBe(1);
  });
});

/**
 * Cold-load race (dev, 2026-09-05 — "This project didn't load." on some
 * opens). The SDK request path calls `getSupabaseAccessToken()` ONCE, with no
 * retry, the moment a query mounts. That fetch is usually still in flight when
 * `AuthProvider` finishes hydrating and writes the live session through
 * `setCachedAuthToken(token)`. The epoch guard above then discarded the fetch
 * as stale and returned NULL — even though the cache now held the exact token
 * the caller needed — so the SDK answered a synthetic `AuthError` and the
 * boundary rendered the terminal error screen. A write that ESTABLISHES an
 * identity is the answer, not a reason to have none.
 */
describe('getSupabaseAccessToken: an authoritative token write lands mid-flight', () => {
  test('returns the token the write established — not null', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const pending = getSupabaseAccessToken(); // starts the fetch, cache empty

    // AuthProvider hydrates while the fetch is still in flight.
    setCachedAuthToken('live-token-from-auth-provider');

    fetch.resolve('token-from-the-in-flight-fetch');

    await expect(pending).resolves.toBe('live-token-from-auth-provider');
    // The authoritative write stays in the cache; the fetch result never
    // overwrites it.
    await expect(getSupabaseAccessToken()).resolves.toBe('live-token-from-auth-provider');
  });

  test('a piggybacking caller gets the established token too', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const callerA = getSupabaseAccessToken();
    const callerB = getSupabaseAccessToken();

    setCachedAuthToken('live-token-from-auth-provider');
    // The provider clears bootstrap mode right after (a second epoch bump
    // with the cache still holding the token).
    setBootstrapAuthToken(null);
    fetch.resolve('token-from-the-in-flight-fetch');

    await expect(callerA).resolves.toBe('live-token-from-auth-provider');
    await expect(callerB).resolves.toBe('live-token-from-auth-provider');
  });

  test('a bootstrap token written mid-flight is returned as well', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const pending = getSupabaseAccessToken();
    setBootstrapAuthToken('bootstrap-token');
    fetch.resolve('token-from-the-in-flight-fetch');

    await expect(pending).resolves.toBe('bootstrap-token');
  });
});

describe('getSupabaseAccessToken: a clear is an identity boundary even when a token follows it', () => {
  test('clear → new token, both mid-flight: the fetch that began before the clear still gets null', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const pending = getSupabaseAccessToken(); // began under identity A

    setCachedAuthToken(null); // sign-out / 401: boundary
    setCachedAuthToken('identity-b-token'); // a new sign-in lands

    fetch.resolve('identity-a-token');

    // Never identity B's token for a request identity A issued.
    await expect(pending).resolves.toBeNull();
    // A fresh caller belongs to identity B and gets B.
    await expect(getSupabaseAccessToken()).resolves.toBe('identity-b-token');
  });
});
