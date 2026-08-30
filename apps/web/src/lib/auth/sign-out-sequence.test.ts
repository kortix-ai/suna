import { describe, expect, test } from 'bun:test';

import {
  isSigningOut,
  markSignOutStarted,
  runSignOut,
  SIGN_OUT_DESTINATION,
  type SignOutSteps,
} from './sign-out-sequence';

/** Small enough that a "this step hangs" test finishes instantly. */
const FAST = { stepTimeoutMs: 5 };

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

  test('a hung sign-out is retried locally, then resets and leaves', async () => {
    const r = recorder({
      endSession: (scope) => (scope === 'local' ? Promise.resolve({ error: null }) : hang()),
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
      'endSession:local',
      'dropAuthCookie',
      'resetClientState',
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
    await runSignOut(r.steps, { stepTimeoutMs: 20 });
    const elapsed = Date.now() - started;

    // Four bounded steps at 20ms. Generous ceiling so a loaded CI box does not
    // flake; the point is that it is BOUNDED, not that it is exact.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * The in-flight latch. Placed LAST in this file on purpose: it is module state
 * that never resets, so marking it earlier would leak into the tests above.
 * Nothing before this point calls `markSignOutStarted` — only `performSignOut`
 * does, and that lives in the other module.
 */
describe('the sign-out in-flight latch', () => {
  test('is false until a sign-out starts, then latches', () => {
    expect(isSigningOut()).toBe(false);
    markSignOutStarted();
    expect(isSigningOut()).toBe(true);
  });
});
