import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ActiveTurnRenewalDependencies,
  activeTurnRenewalIntervalMs,
  runActiveTurnRenewal,
  startActiveTurnRenewal,
  stopActiveTurnRenewal,
} from './active-turn-renewal';
import type { ReapResult } from './sandbox-reaper';

function reapResult(overrides: Partial<ReapResult> = {}): ReapResult {
  return {
    candidates: 0,
    matching: 0,
    deferred: 0,
    stopped: 0,
    reconciled: 0,
    billingClosed: 0,
    skipped: 0,
    lifecycleRenewed: 0,
    husksFinalized: 0,
    turnsSettled: 0,
    errors: 0,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  stopActiveTurnRenewal();
});

describe('active-turn lifecycle renewal loop', () => {
  test('runs faster than the one-minute provider lifecycle test timeout', () => {
    expect(activeTurnRenewalIntervalMs({})).toBe(20_000);
    expect(
      activeTurnRenewalIntervalMs({
        KORTIX_ACTIVE_TURN_RENEWAL_INTERVAL_MS: '60000',
      }),
    ).toBe(30_000);
    expect(
      activeTurnRenewalIntervalMs({
        KORTIX_ACTIVE_TURN_RENEWAL_INTERVAL_MS: '1000',
      }),
    ).toBe(5_000);
  });

  test('reaps only rows with durable active-turn authority', async () => {
    const calls: unknown[][] = [];
    const result = await runActiveTurnRenewal({
      reap: async (...args: unknown[]) => {
        calls.push(args);
        return reapResult({ candidates: 1, matching: 1, skipped: 1, lifecycleRenewed: 1 });
      },
      now: () => new Date('2026-08-17T06:00:00.000Z'),
    });

    expect(result.lifecycleRenewed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(new Date('2026-08-17T06:00:00.000Z'));
    expect(calls[0]?.[2]).toEqual({ activeTurnsOnly: true });
  });

  test('start schedules serial passes and stop cancels the pending pass', async () => {
    let runs = 0;
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const cancelled: Array<ReturnType<typeof setTimeout>> = [];
    const timer = 101 as unknown as ReturnType<typeof setTimeout>;

    const dependencies: ActiveTurnRenewalDependencies = {
      reap: async () => {
        runs += 1;
        return reapResult();
      },
      schedule: (callback, delayMs) => {
        callbacks.push(callback);
        delays.push(delayMs);
        return timer;
      },
      cancel: (pending) => cancelled.push(pending),
      intervalMs: () => 20_000,
      monotonicNowMs: () => 0,
    };
    startActiveTurnRenewal(dependencies);
    startActiveTurnRenewal(dependencies);
    await flushAsync();

    expect(runs).toBe(1);
    expect(callbacks).toHaveLength(1);
    expect(delays).toEqual([20_000]);

    stopActiveTurnRenewal();
    expect(cancelled).toEqual([timer]);

    callbacks[0]?.();
    await flushAsync();
    expect(runs).toBe(1);
  });

  test('a slow pass subtracts its runtime from the next delay', async () => {
    const delays: number[] = [];
    const clock = [1_000, 19_000];

    startActiveTurnRenewal({
      reap: async () => reapResult(),
      schedule: (_callback, delayMs) => {
        delays.push(delayMs);
        return 301 as unknown as ReturnType<typeof setTimeout>;
      },
      intervalMs: () => 20_000,
      monotonicNowMs: () => clock.shift() ?? 19_000,
    });
    await flushAsync();

    expect(delays).toEqual([2_000]);
  });

  test('an in-flight pass cannot reschedule after stop and restart', async () => {
    let finishOldPass: (() => void) | undefined;
    const oldPass = new Promise<void>((resolve) => {
      finishOldPass = resolve;
    });
    const oldCallbacks: Array<() => void> = [];
    const newCallbacks: Array<() => void> = [];
    let oldRuns = 0;
    let newRuns = 0;

    startActiveTurnRenewal({
      reap: async () => {
        oldRuns += 1;
        await oldPass;
        return reapResult();
      },
      schedule: (callback) => {
        oldCallbacks.push(callback);
        return 201 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    await flushAsync();
    expect(oldRuns).toBe(1);

    stopActiveTurnRenewal();
    startActiveTurnRenewal({
      reap: async () => {
        newRuns += 1;
        return reapResult();
      },
      schedule: (callback) => {
        newCallbacks.push(callback);
        return 202 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    await flushAsync();
    expect(newRuns).toBe(1);
    expect(newCallbacks).toHaveLength(1);

    finishOldPass?.();
    await flushAsync();
    expect(oldCallbacks).toHaveLength(0);
    expect(newCallbacks).toHaveLength(1);
  });

  test('the explicit disable flag starts no pass', async () => {
    let runs = 0;
    startActiveTurnRenewal(
      {
        reap: async () => {
          runs += 1;
          return reapResult();
        },
      },
      { KORTIX_ACTIVE_TURN_RENEWAL_ENABLED: 'false' },
    );
    await flushAsync();
    expect(runs).toBe(0);
  });
});
