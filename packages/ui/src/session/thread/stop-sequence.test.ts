import { describe, expect, test } from 'bun:test';
import type { AbortSettlement } from '@kortix/sdk/react';
import { createStopLatch, runStopSequence, stopLeftTurnRunning, type StopSequenceDeps } from './stop-sequence';

function harness(overrides: Partial<StopSequenceDeps> = {}) {
  const calls: string[] = [];
  const deps: StopSequenceDeps = {
    holdInbox: async () => {
      calls.push('hold');
    },
    fallbackCancel: async () => {
      calls.push('abort');
      return { status: 'aborted' } as AbortSettlement;
    },
    paintOptimisticAbort: () => {
      calls.push('paint');
    },
    refusalOf: () => null,
    onHoldFailed: () => {
      calls.push('hold-failed');
    },
    holdDeadlineMs: 1_500,
    ...overrides,
  };
  return { calls, deps };
}

describe('runStopSequence', () => {
  test('with the session hook mounted, one Stop is one SDK cancel and no host hold', async () => {
    const { calls, deps } = harness({
      sdkCancel: async () => {
        calls.push('sdk-cancel');
        return { status: 'aborted' } as AbortSettlement;
      },
    });
    const outcome = await runStopSequence(deps);
    expect(calls).toEqual(['sdk-cancel']);
    expect(outcome).toEqual({ kind: 'cancelled', settlement: { status: 'aborted' } });
  });

  test('without the hook, the host holds once and then aborts once, in that order', async () => {
    const { calls, deps } = harness();
    await runStopSequence(deps);
    expect(calls).toEqual(['paint', 'hold', 'abort']);
  });

  test('a refused hold sends no abort', async () => {
    const { calls, deps } = harness({
      holdInbox: async () => {
        calls.push('hold');
        throw new Error('403');
      },
      refusalOf: () => 'Only the member who started this run can stop it.',
    });
    const outcome = await runStopSequence(deps);
    expect(calls).toEqual(['paint', 'hold']);
    expect(outcome).toEqual({ kind: 'refused', message: 'Only the member who started this run can stop it.' });
  });

  test('a failed hold is reported and the abort still goes out', async () => {
    const { calls, deps } = harness({
      holdInbox: async () => {
        calls.push('hold');
        throw new Error('502');
      },
    });
    await runStopSequence(deps);
    expect(calls).toEqual(['paint', 'hold', 'hold-failed', 'abort']);
  });

  test('a hung hold delays the abort by the deadline only', async () => {
    const { calls, deps } = harness({
      holdInbox: () => {
        calls.push('hold');
        return new Promise(() => {});
      },
      holdDeadlineMs: 10,
    });
    const started = Date.now();
    await runStopSequence(deps);
    expect(calls).toEqual(['paint', 'hold', 'abort']);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('createStopLatch', () => {
  test('a second Stop while the first settles does nothing', async () => {
    const latch = createStopLatch();
    let release: () => void = () => {};
    let runs = 0;
    const first = latch.run(() => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    // Synchronous: no render between the clicks.
    const second = latch.run(async () => {
      runs += 1;
    });
    const third = latch.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(1);
    expect(await second).toBeUndefined();
    expect(await third).toBeUndefined();
    release();
    await first;
    expect(latch.inFlight).toBe(false);
    await latch.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });

  test('the latch opens again when the stop throws', async () => {
    const latch = createStopLatch();
    await expect(
      latch.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(latch.inFlight).toBe(false);
  });
});

describe('stopLeftTurnRunning', () => {
  test('only an unconfirmed or refused stop keeps the Stop control', () => {
    expect(stopLeftTurnRunning({ kind: 'cancelled', settlement: { status: 'aborted' } as AbortSettlement })).toBe(false);
    expect(stopLeftTurnRunning({ kind: 'cancelled', settlement: { status: 'skipped' } as AbortSettlement })).toBe(false);
    expect(stopLeftTurnRunning({ kind: 'cancelled', settlement: { status: 'timed-out' } as AbortSettlement })).toBe(true);
    expect(
      stopLeftTurnRunning({ kind: 'cancelled', settlement: { status: 'failed', error: new Error('x') } as AbortSettlement }),
    ).toBe(true);
    expect(stopLeftTurnRunning({ kind: 'refused', message: 'no' })).toBe(true);
    expect(stopLeftTurnRunning(undefined)).toBe(false);
  });
});
