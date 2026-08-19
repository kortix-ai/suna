import { describe, expect, test } from 'bun:test';
import type { AbortSettlement } from '@kortix/sdk/react';
import { stopThenSendNow, type StopThenSendNowDeps } from './session-chat';

// T10: "Stop & send" used to gate its send on `waitForSessionIdle`,
// which polled the sync-store status slot — the slot the abort's optimistic
// idle frame flipped SYNCHRONOUSLY, before the abort request round-tripped to
// the server. That let the send race the still-in-flight abort.
// `stopThenSendNow` is the extracted, framework-free orchestration that fixes
// this: it awaits the real `AbortSettlement` the stop produces instead. The
// `waitIdle` fallback is gone with the fabricated frame (C4): with the frame
// the poll resolved on its first check at every reachable call site, and
// without it the predicate is constant the other way — so a `null` settlement
// simply dispatches. There is nothing to wait for.
//
// It also dispatches WITHOUT touching the session's inbox hold. "Send now" is
// `POST .../prompts/:id/retry`, which promotes the row the user pointed at and
// THEN releases the hold (`retryInboxPrompt`). Releasing the hold first made
// every held row due at the same instant and kicked a drain, and the drain
// claims by `available_at, created_at` — so the OLDEST prompt ran instead of
// the one the user clicked. The correct order is a property of the server
// primitive; the client must not invert it by lifting the hold on the side.
//
// `stopThenSendNow` is a real (not source-sliced) import — unlike this
// directory's other `session-chat.tsx` tests, which source-slice because the
// component itself has no DOM harness to render. This logic is plain async
// TypeScript with injected dependencies, so it is directly callable and its
// assertions can actually fail on wrong behavior, not just wrong wiring shape.

/** A promise plus external `resolve`, so a test can control exactly when the
 *  fake settlement "arrives" and assert nothing downstream ran before that. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function baseDeps(overrides: Partial<StopThenSendNowDeps> = {}): StopThenSendNowDeps {
  return {
    isRunning: () => false,
    pendingSettlement: () => undefined,
    stop: async () => null,
    dispatch: async () => {},
    ...overrides,
  };
}

describe('stopThenSendNow', () => {
  test('a send with no preceding stop is not delayed: stop() is never called', async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      isRunning: () => false,
      stop: async () => {
        calls.push('stop');
        return { status: 'aborted' };
      },
      dispatch: async () => {
        calls.push('dispatch');
      },
    });

    await stopThenSendNow(deps);

    expect(calls).toEqual(['dispatch']);
  });

  test('stop then immediate send-now: dispatch fires only after the settlement resolves', async () => {
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: () => {
          calls.push('stop-issued');
          return settlement.promise;
        },
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    // Give the microtask queue a turn — if `dispatch` were reachable before
    // the settlement resolves, it would have run by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['stop-issued']);

    settlement.resolve({ status: 'aborted' });
    await runPromise;

    expect(calls).toEqual(['stop-issued', 'dispatch']);
  });

  test('a failed settlement still lets the send dispatch once resolved', async () => {
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: () => settlement.promise,
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    await Promise.resolve();
    expect(calls).toEqual([]);

    settlement.resolve({ status: 'failed', error: new Error('abort request rejected') });
    await runPromise;

    expect(calls).toEqual(['dispatch']);
  });

  test('a timed-out settlement still lets the send dispatch after the bound', async () => {
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: () => settlement.promise,
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    await Promise.resolve();
    expect(calls).toEqual([]);

    settlement.resolve({ status: 'timed-out' });
    await runPromise;

    expect(calls).toEqual(['dispatch']);
  });

  test('a `null` settlement (no trackable AbortSettlement) dispatches at once — there is nothing to wait for', async () => {
    const calls: string[] = [];

    await stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: async () => {
          calls.push('stop');
          return null;
        },
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    expect(calls).toEqual(['stop', 'dispatch']);
  });

  test('stop already issued (settlement pending, store already idle): send-now awaits the pending settlement instead of trusting isRunning()', async () => {
    // Reproduces the reported race: `handleStop` files an abort receipt, which
    // makes the projection answer idle at once, then stashes the real
    // `AbortSettlement` in `pendingAbortSettlementRef`. If the user then clicks
    // "Send now" on a queued row, `isRunning()` reads idle (false) — but a
    // stop is still in flight. `stopThenSendNow` must consult the pending
    // settlement FIRST, not `isRunning()`, and must NOT call `stop()` again
    // (that would issue a second, redundant cancel).
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => false,
        pendingSettlement: () => settlement.promise,
        stop: async () => {
          calls.push('stop');
          return { status: 'aborted' };
        },
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    // Give the microtask queue a turn — if `dispatch` were reachable before
    // the pending settlement resolves, it would have run by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);

    settlement.resolve({ status: 'aborted' });
    await runPromise;

    expect(calls).toEqual(['dispatch']);
  });
});
