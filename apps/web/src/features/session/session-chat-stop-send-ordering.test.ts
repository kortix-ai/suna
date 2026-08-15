import { describe, expect, test } from 'bun:test';
import type { AbortSettlement } from '@kortix/sdk/react';
import { stopThenSendNow, type StopThenSendNowDeps } from './session-chat';

// T10: "Stop & send" used to gate its send on `waitForSessionIdle`,
// which polls the sync store `applyOptimisticAbort` flips to idle
// SYNCHRONOUSLY — before the abort request round-trips to the server. That
// let the send race the still-in-flight abort. `stopThenSendNow` is the
// extracted, framework-free orchestration that fixes this: it awaits the
// real `AbortSettlement` the stop produces instead.
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
    stop: async () => null,
    waitIdle: async () => {},
    resumeQueue: () => {},
    dispatch: async () => {},
    ...overrides,
  };
}

describe('stopThenSendNow', () => {
  test('a send with no preceding stop is not delayed: stop() and waitIdle() are never called', async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      isRunning: () => false,
      stop: async () => {
        calls.push('stop');
        return { status: 'aborted' };
      },
      waitIdle: async () => {
        calls.push('waitIdle');
      },
      resumeQueue: () => calls.push('resumeQueue'),
      dispatch: async () => {
        calls.push('dispatch');
      },
    });

    await stopThenSendNow(deps);

    expect(calls).toEqual(['resumeQueue', 'dispatch']);
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
        resumeQueue: () => calls.push('resumeQueue'),
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

    expect(calls).toEqual(['stop-issued', 'resumeQueue', 'dispatch']);
  });

  test('a failed settlement still lets the send dispatch once resolved', async () => {
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: () => settlement.promise,
        resumeQueue: () => calls.push('resumeQueue'),
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    await Promise.resolve();
    expect(calls).toEqual([]);

    settlement.resolve({ status: 'failed', error: new Error('abort request rejected') });
    await runPromise;

    expect(calls).toEqual(['resumeQueue', 'dispatch']);
  });

  test('a timed-out settlement still lets the send dispatch after the bound', async () => {
    const calls: string[] = [];
    const settlement = deferred<AbortSettlement>();

    const runPromise = stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: () => settlement.promise,
        resumeQueue: () => calls.push('resumeQueue'),
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    await Promise.resolve();
    expect(calls).toEqual([]);

    settlement.resolve({ status: 'timed-out' });
    await runPromise;

    expect(calls).toEqual(['resumeQueue', 'dispatch']);
  });

  test('a `null` settlement (no trackable AbortSettlement) falls back to waitIdle before dispatching', async () => {
    const calls: string[] = [];

    await stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: async () => {
          calls.push('stop');
          return null;
        },
        waitIdle: async () => {
          calls.push('waitIdle');
        },
        resumeQueue: () => calls.push('resumeQueue'),
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    expect(calls).toEqual(['stop', 'waitIdle', 'resumeQueue', 'dispatch']);
  });

  test('a real (non-null) settlement never falls back to waitIdle', async () => {
    const calls: string[] = [];

    await stopThenSendNow(
      baseDeps({
        isRunning: () => true,
        stop: async () => ({ status: 'aborted' }),
        waitIdle: async () => {
          calls.push('waitIdle');
        },
        resumeQueue: () => calls.push('resumeQueue'),
        dispatch: async () => {
          calls.push('dispatch');
        },
      }),
    );

    expect(calls).toEqual(['resumeQueue', 'dispatch']);
  });
});
