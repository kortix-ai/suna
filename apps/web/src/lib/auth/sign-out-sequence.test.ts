import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetSignOutLatchForTests,
  isSigningOut,
  runSignOut,
  SIGN_OUT_BUDGETS_MS,
  SIGN_OUT_DESTINATION,
  type SignOutSteps,
} from './sign-out-sequence';

/** Small enough that a "this step hangs" test finishes instantly. */
const FAST = {
  budgets: { finalizeServerSession: 5, endSession: 5, resetClientState: 5 },
};

// The latch is module state that production never clears, because the only
// thing that ends a sign-out is the document being replaced. Every test here
// runs a fresh sign-out, so every test starts from a fresh latch.
beforeEach(() => __resetSignOutLatchForTests());

/**
 * The sign-out ORDER and its failure handling, on injected steps.
 *
 * Dependency injection rather than `mock.module`: a module mock in this repo is
 * process-wide, and these assertions are about the sequence `runSignOut` runs,
 * not about who supplies each step.
 */

type Recorder = {
  calls: string[];
  steps: SignOutSteps;
  scopes: (string | undefined)[];
  destinations: string[];
};

function recorder(
  overrides: Partial<{
    endSession: (scope?: 'local') => Promise<{ error: { message?: string } | null }>;
    finalizeServerSession: () => Promise<void>;
    resetClientState: () => Promise<void>;
  }> = {},
): Recorder {
  const calls: string[] = [];
  const scopes: (string | undefined)[] = [];
  const destinations: string[] = [];

  return {
    calls,
    scopes,
    destinations,
    steps: {
      finalizeServerSession: async () => {
        calls.push('finalizeServerSession');
        if (overrides.finalizeServerSession) await overrides.finalizeServerSession();
      },
      dropAuthCookie: () => {
        calls.push('dropAuthCookie');
      },
      endSession: async (scope) => {
        calls.push(scope ? `endSession:${scope}` : 'endSession');
        scopes.push(scope);
        return overrides.endSession ? overrides.endSession(scope) : { error: null };
      },
      resetClientState: async () => {
        calls.push('resetClientState');
        if (overrides.resetClientState) await overrides.resetClientState();
      },
      leave: (destination) => {
        calls.push('leave');
        destinations.push(destination);
      },
    },
  };
}

describe('runSignOut, happy path', () => {
  test('ends the session once, clears the bounce, resets, then leaves', async () => {
    const r = recorder();
    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual(['finalizeServerSession', 'endSession', 'resetClientState', 'leave']);
    expect(r.scopes).toEqual([undefined]);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('the destination is /auth', () => {
    expect(SIGN_OUT_DESTINATION).toBe('/auth');
  });

  test('the SERVER-side sign-out runs before the browser drops its session', () => {
    // Order, not decoration: `finalizeServerSignOut` authenticates with the
    // access token that `supabase.auth.signOut()` is about to throw away, so
    // running it second would silently stop revoking anything.
    const r = recorder();
    return runSignOut(r.steps, FAST).then(() => {
      expect(r.calls.indexOf('finalizeServerSession')).toBeLessThan(
        r.calls.indexOf('endSession'),
      );
    });
  });
});

describe('runSignOut, the signOut ERROR path', () => {
  test('retries locally, still resets, and still leaves', async () => {
    // The defect this pins: every previous control discarded `{ error }`. On
    // that path Supabase removed no session and fired no `SIGNED_OUT`, so
    // nothing was cleared — and the user was navigated away regardless.
    let attempt = 0;
    const r = recorder({
      endSession: async (scope) => {
        attempt += 1;
        return scope === 'local' ? { error: null } : { error: { message: 'network down' } };
      },
    });

    await runSignOut(r.steps, FAST);

    expect(attempt).toBe(2);
    expect(r.calls).toEqual([
      'finalizeServerSession',
      'endSession',
      'endSession:local',
      'resetClientState',
      'leave',
    ]);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('a local retry that ALSO fails EXPIRES THE AUTH COOKIE, then resets and leaves', async () => {
    // The security defect this closes. `scope: 'local'` is not local: in
    // `@supabase/auth-js@2.110.0` it still POSTs to `/logout` and, on anything
    // that is not 404/401/403, returns BEFORE `_removeSession()`. Offline and
    // 5xx defeat both calls, and nothing else on this path touches the auth
    // cookie — so without this step the user waits the full budget, lands on
    // `/auth` with a live session, and is bounced straight back into the app.
    const r = recorder({ endSession: async () => ({ error: { message: 'nope' } }) });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual([
      'finalizeServerSession',
      'endSession',
      'endSession:local',
      'dropAuthCookie',
      'resetClientState',
      // AGAIN, immediately before leaving: with the session never removed,
      // auth-js still holds it in memory with `autoRefreshToken` ticking, and a
      // refresh in the reset window writes it straight back into the cookie.
      'dropAuthCookie',
      'leave',
    ]);
  });

  test('the cookie is expired BEFORE the navigation, not after', async () => {
    // After `leave()` the document is being replaced; a write racing a document
    // load is not a guarantee of anything.
    const r = recorder({ endSession: async () => ({ error: { message: 'nope' } }) });

    await runSignOut(r.steps, FAST);

    expect(r.calls.indexOf('dropAuthCookie')).toBeLessThan(r.calls.indexOf('leave'));
  });

  test('a clean sign-out does NOT touch the cookie', async () => {
    // The paired negative. Without it, an unconditional `dropAuthCookie()`
    // passes every assertion above while doing work on the happy path that
    // Supabase has already done correctly.
    const r = recorder();

    await runSignOut(r.steps, FAST);

    expect(r.calls).not.toContain('dropAuthCookie');
  });

  test('a retry that SUCCEEDS does not touch the cookie either', async () => {
    const r = recorder({
      endSession: async (scope) =>
        scope === 'local' ? { error: null } : { error: { message: 'network down' } },
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).not.toContain('dropAuthCookie');
  });

  test('a THROWN sign-out is retried locally too', async () => {
    // A thrown fetch is the archetypal "the server was unreachable", which is
    // exactly when a local sign-out is the right answer. Treating a throw as
    // terminal left the session in the browser.
    const r = recorder({
      endSession: async (scope) => {
        if (scope === 'local') return { error: null };
        throw new Error('boom');
      },
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual([
      'finalizeServerSession',
      'endSession',
      'endSession:local',
      'resetClientState',
      'leave',
    ]);
  });
});

describe('runSignOut, nothing can strand a signed-out user', () => {
  test('a failed SERVER-side sign-out does not skip the client sign-out', async () => {
    // The API revoke and the audit are best effort. A backend that is down must
    // never be able to keep a user signed in on this browser.
    const r = recorder({
      finalizeServerSession: async () => {
        throw new Error('server action unreachable');
      },
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual(['finalizeServerSession', 'endSession', 'resetClientState', 'leave']);
  });

  test('a failed reset does not skip the navigation', async () => {
    const r = recorder({
      resetClientState: async () => {
        throw new Error('indexedDB blocked');
      },
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual(['finalizeServerSession', 'endSession', 'resetClientState', 'leave']);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('the reset always completes BEFORE the navigation starts', async () => {
    // Reversing these would hand the next document a cache the previous user
    // owned, because the reset would still be in flight when the load begins.
    const order: string[] = [];
    let resolveReset: (() => void) | null = null;

    const steps: SignOutSteps = {
      finalizeServerSession: async () => {},
      endSession: async () => ({ error: null }),
      dropAuthCookie: () => {},
      resetClientState: () =>
        new Promise<void>((resolve) => {
          resolveReset = () => {
            order.push('reset-finished');
            resolve();
          };
        }),
      leave: () => order.push('left'),
    };

    const running = runSignOut(steps, FAST);
    // Drain the microtasks the two awaited steps ahead of the reset queue, so
    // the assertion below is about the reset gate and not about scheduling.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(order).toEqual([]);

    resolveReset!();
    await running;

    expect(order).toEqual(['reset-finished', 'left']);
  });
});

/**
 * The blocker this round fixed. Each of these steps could hang FOREVER, and one
 * of them demonstrably can: `resetClientState()` awaits `clearSessionIDBCache()`,
 * whose `openDB()` registers no `onblocked` handler, so an upgrade blocked by a
 * stale tab settles neither `success` nor `error`. Unbounded, `leave()` was
 * never reached — the user could not sign out and saw no error.
 *
 * A `try`/`catch` cannot catch a promise that never settles. Only a clock can,
 * which is why every one of these uses a hanging promise rather than a
 * rejecting one.
 */
describe('runSignOut, a step that NEVER settles cannot trap the user', () => {
  const hang = () => new Promise<never>(() => {});

  test('a hung server half still ends the session, resets and leaves', async () => {
    const r = recorder({ finalizeServerSession: hang });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual(['finalizeServerSession', 'endSession', 'resetClientState', 'leave']);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('a hung sign-out is NOT retried — it expires the cookie instead', async () => {
    // A timeout carries no error to classify and the request is still in
    // flight; `scope: 'local'` posts to the same host and can only fail the
    // same way, one budget later. Skipping it is what keeps the worst case at
    // 6.0s instead of 8.0s, and the cookie is what makes skipping it safe.
    const r = recorder({ endSession: hang });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual([
      'finalizeServerSession',
      'endSession',
      'dropAuthCookie',
      'resetClientState',
      'dropAuthCookie',
      'leave',
    ]);
  });

  test('a settled AuthRetryableFetchError is not retried either', async () => {
    // auth-js's own tag for "the fetch did not complete" — offline, DNS. Same
    // reasoning as the timeout above, but with an error object to read.
    const r = recorder({
      endSession: async () => ({ error: { name: 'AuthRetryableFetchError', message: 'offline' } }),
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).not.toContain('endSession:local');
    expect(r.calls).toContain('dropAuthCookie');
  });

  test('a settled HTTP error IS retried — global and local are different writes', async () => {
    // The paired positive. `scope: 'global'` revokes every refresh token for
    // the user and is a heavier server write than `scope: 'local'`, so a global
    // 500 beside a local 200 is a real outcome. Collapsing "any failure" into
    // "never retry" would throw that away.
    const r = recorder({
      endSession: async (scope) =>
        scope === 'local'
          ? { error: null }
          : { error: { name: 'AuthApiError', status: 500, message: 'boom' } },
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toContain('endSession:local');
    expect(r.calls).not.toContain('dropAuthCookie');
  });

  test('a hung reset — the real IndexedDB case — still leaves', async () => {
    const r = recorder({ resetClientState: hang });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual(['finalizeServerSession', 'endSession', 'resetClientState', 'leave']);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('EVERY step hanging at once still expires the cookie and still leaves', async () => {
    const r = recorder({
      finalizeServerSession: hang,
      endSession: hang,
      resetClientState: hang,
    });

    await runSignOut(r.steps, FAST);

    expect(r.calls).toEqual([
      'finalizeServerSession',
      'endSession',
      'dropAuthCookie',
      'resetClientState',
      'dropAuthCookie',
      'leave',
    ]);
    expect(r.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('the whole sequence finishes in roughly the sum of its budgets', async () => {
    const r = recorder({
      finalizeServerSession: hang,
      endSession: hang,
      resetClientState: hang,
    });

    const started = Date.now();
    await runSignOut(r.steps, { budgets: { finalizeServerSession: 20, endSession: 20, resetClientState: 20 } });
    const elapsed = Date.now() - started;

    // Four bounded steps at 20ms. Generous ceiling so a loaded CI box does not
    // flake; the point is that it is BOUNDED, not that it is exact.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * The in-flight latch, and what a SECOND press does.
 *
 * The product path is real: press Log out with unsaved file edits open, and the
 * `beforeunload` handler in `file-viewer/file-content-renderer.tsx` raises the
 * browser's "Leave site?" prompt. Pressing Stay cancels the navigation and
 * leaves the user inside the app — signed out, with the latch set.
 *
 * Refusing silently, as an earlier revision did, made that state PERMANENT:
 * every later press was a no-op, the control stayed `disabled` (the pending
 * flags are never cleared, by design), and `useSignedOutRedirect` had already
 * stood down. The user had no working way to leave.
 */
describe('a second press never runs a second sequence, but always leaves', () => {
  test('the first run latches; the second only navigates', async () => {
    const first = recorder();
    await runSignOut(first.steps, FAST);
    expect(isSigningOut()).toBe(true);

    const second = recorder();
    await runSignOut(second.steps, FAST);

    // Nothing re-issued: no server revoke, no sign-out, no reset.
    expect(second.calls).toEqual(['leave']);
    expect(second.destinations).toEqual([SIGN_OUT_DESTINATION]);
  });

  test('the latch is set before the first step can fire SIGNED_OUT', async () => {
    // `useSignedOutRedirect` reads it. If `endSession` fires `SIGNED_OUT` before
    // the latch is set, the guard's soft `router.replace('/auth')` wins the race
    // and the route cache survives the identity change.
    let latchedDuringFirstStep = false;
    const r = recorder({
      finalizeServerSession: async () => {
        latchedDuringFirstStep = isSigningOut();
      },
    });

    await runSignOut(r.steps, FAST);

    expect(latchedDuringFirstStep).toBe(true);
  });

  test('it starts unlatched', () => {
    // `beforeEach` resets it; this pins that the reset works, so every other
    // test in this file is running a genuine first sign-out.
    expect(isSigningOut()).toBe(false);
  });
});

describe('the budgets', () => {
  test('are 3s / 2s / 1s', () => {
    expect(SIGN_OUT_BUDGETS_MS).toEqual({
      finalizeServerSession: 3_000,
      endSession: 2_000,
      resetClientState: 1_000,
    });
  });

  test('the server revoke is not tighter than its own AbortSignal', () => {
    // `finalizeServerSignOut` uses `AbortSignal.timeout(3_000)`. A tighter outer
    // bound would mean that abort could never fire while anyone waits, and the
    // request would only land because later steps happen to keep the document
    // alive — accidental coupling that every future latency cut would erode.
    expect(SIGN_OUT_BUDGETS_MS.finalizeServerSession).toBeGreaterThanOrEqual(3_000);
  });
});

/**
 * The REAL worst-case ceiling, proven by running `runSignOut` on a clock —
 * not by summing constants and asserting the sum, which is what stood here
 * before and which cannot fail no matter what `runSignOut` actually does.
 *
 * The scenario: a SETTLED, non-network HTTP error (a 500) that happens to
 * resolve near the end of the first `endSession` budget.
 * `isNetworkClassFailure` only skips the retry for `{status: 'timeout'}` or a
 * settled `AuthRetryableFetchError` — a plain 500 is neither, so the retry
 * fires and gets its OWN fresh `budgets.endSession`, not the leftover of the
 * first. That makes `endSession` run TWICE, which is exactly what the false
 * "sum of three" ceiling could not see.
 */
describe('the true sign-out ceiling is 8.0s (endSession can run twice), not 6.0s', () => {
  test('a settled non-network endSession failure buys the retry a FRESH full budget', async () => {
    // Scaled down from the real 3000/2000/1000 (same 3:2:1 ratio) so the test
    // runs in milliseconds, not seconds.
    const budgets = { finalizeServerSession: 10, endSession: 100, resetClientState: 10 };

    // Settles just under its budget with a plain HTTP error — proven, not
    // hung: `isNetworkClassFailure` reads `status === 'timeout'` only when
    // `withTimeBudget` itself gives up, so this must SETTLE inside its
    // budget to reach the "settled HTTP error" branch at all.
    const settleNearBudgetEnd = () =>
      new Promise<{ error: { status: number; message: string } }>((resolve) => {
        setTimeout(
          () => resolve({ error: { status: 500, message: 'boom' } }),
          Math.round(budgets.endSession * 0.85),
        );
      });

    const r = recorder({ endSession: settleNearBudgetEnd });

    const started = Date.now();
    await runSignOut(r.steps, { budgets });
    const elapsed = Date.now() - started;

    // Both attempts genuinely ran — the second `endSession` budget is real,
    // not theoretical.
    expect(r.calls.filter((c) => c === 'endSession' || c === 'endSession:local')).toEqual([
      'endSession',
      'endSession:local',
    ]);

    // The FALSE ceiling the old test pinned: the sum of the three DISTINCT
    // budgets, counting `endSession` once.
    const falseCeiling =
      budgets.finalizeServerSession + budgets.endSession + budgets.resetClientState;
    // The TRUE ceiling: `endSession` counted twice, matching the doc comment
    // fixed alongside this test (`sign-out-sequence.ts`).
    const trueCeiling = falseCeiling + budgets.endSession;

    // Falsifies the "sum of three" claim: elapsed clears it, because the
    // retry consumed a WHOLE second `endSession` budget rather than sharing
    // what was left of the first. If the retry instead shared the first
    // attempt's remaining budget (the change that would make 6.0s true),
    // elapsed would land near `falseCeiling`, not clear it — see this
    // test's mutation proof in the final-fix-wave report.
    expect(elapsed).toBeGreaterThan(falseCeiling);
    // Still bounded near the real (four-budget) ceiling — generous slack for
    // scheduler jitter, not room for a fifth budget to appear from nowhere.
    expect(elapsed).toBeLessThan(trueCeiling + 80);
  });
});
