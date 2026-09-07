import { afterEach, describe, expect, test } from 'bun:test';

import {
  __expireCachedTokenForTests,
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

    // The invariant this test exists for: the ABANDONED fetch's answer never
    // escapes — not as a return value, not into the cache.
    await expect(pending).resolves.not.toBe('first-caller-stale-token');
    await expect(getSupabaseAccessToken()).resolves.toBe('second-caller-token');

    // It resolves to the token established under the CURRENT epoch rather
    // than to `null`. This assertion used to read `.toBeNull()`, which
    // conflated "your fetch was overtaken" with "you have no session" — the
    // conflation behind the "This project didn't load." screen (see the
    // mid-flight-publish suite at the bottom of this file). The identity
    // guarantee is unchanged: only a value committed under the current epoch
    // is ever handed back.
    await expect(pending).resolves.toBe('second-caller-token');
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
 * JAY: the "This project didn't load. / The request failed before we could
 * check your access." screen on a COLD project load while properly signed in.
 *
 * The epoch check above is right to refuse to COMMIT an in-flight fetch that
 * an authoritative write overtook. It was wrong about what to RETURN.
 *
 * The overtaking writer is the TOKEN_REFRESHED branch of `onAuthStateChange`
 * (auth-provider.tsx), fired from inside GoTrue's own `initialize()` ->
 * `_recoverAndRefresh()` whenever the stored token is within its 90s expiry
 * margin. It publishes the fresh session (`setCachedAuthToken(access_token)` +
 * `setBootstrapAuthToken(null)` = two epoch bumps) while the project shell's
 * first `getProject` is parked on the same `initializePromise` inside
 * `fetchToken()`. That caller then got `null` — "no session" — for a user whose
 * session had just been published. It is deterministic, not a race: reload a
 * tab that idled past the margin and it fails every time. (Note it is NOT
 * `getInitialSession()`'s publish: that awaits a network `getUser()` and so
 * always lands later.)
 *
 * Nothing downstream absorbs it: `api-client.ts` calls
 * `getSupabaseAccessTokenWithRetry()` with no options, which is ONE attempt
 * (`withTokenRetry`: `attempts ?? 1`), so the null becomes an `AuthError` with
 * no `.status`, and `ProjectAccessBoundary`'s query is `retry: false`, so that
 * AuthError is a terminal verdict.
 *
 * The fix returns what the authoritative writer PUBLISHED, never what the
 * overtaken fetch resolved — so a sign-out (which publishes `null`) still
 * yields null, as the tests above pin.
 */
describe('getSupabaseAccessToken: an authoritative token published mid-flight', () => {
  test('returns the published token rather than reporting "no session" for a signed-in user', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    // The project shell's first getProject asks for a token.
    const pending = getSupabaseAccessToken();

    // AuthProvider finishes its bootstrap while that fetch is in flight and
    // publishes the live session token. Two authoritative writes, two epoch
    // bumps — exactly auth-provider.tsx:95-98.
    setCachedAuthToken('token-published-by-auth-provider');
    setBootstrapAuthToken(null);

    // The overtaken fetch resolves. Its answer must NOT be committed...
    fetch.resolve('token-from-the-overtaken-fetch');

    // ...but the caller is signed in, and the published token is the answer.
    await expect(pending).resolves.toBe('token-published-by-auth-provider');
  });

  test('every piggybacking caller gets the published token too', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const callerA = getSupabaseAccessToken();
    const callerB = getSupabaseAccessToken();

    setCachedAuthToken('token-published-by-auth-provider');
    setBootstrapAuthToken(null);
    fetch.resolve('token-from-the-overtaken-fetch');

    await expect(callerA).resolves.toBe('token-published-by-auth-provider');
    await expect(callerB).resolves.toBe('token-published-by-auth-provider');
  });

  test('a bootstrap token published mid-flight is honoured the same way', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const pending = getSupabaseAccessToken();
    setBootstrapAuthToken('token-seeded-by-a-server-action');
    fetch.resolve('token-from-the-overtaken-fetch');

    await expect(pending).resolves.toBe('token-seeded-by-a-server-action');
  });

  test('an EXPIRED published token is not handed back — a stale cache is still no answer', async () => {
    __resetAuthTokenCacheForTests();
    const fetch = deferred<string | null>();
    __setFetchTokenForTests(() => fetch.promise);

    const pending = getSupabaseAccessToken();
    // Published, then aged past the 30s TTL before the overtaken fetch lands.
    setCachedAuthToken('token-published-by-auth-provider');
    __expireCachedTokenForTests();
    fetch.resolve('token-from-the-overtaken-fetch');

    await expect(pending).resolves.toBeNull();
  });
});
