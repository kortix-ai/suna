import { describe, expect, test } from 'bun:test';

import { DEFAULT_TIME_BUDGET_MS, withTimeBudget } from './time-budget';

/**
 * The clock exists for one reachable hang: `openDB()` in the SDK's
 * `idb-sync-cache` has no `onblocked` handler, so a blocked version upgrade
 * settles NEITHER `success` nor `error`. A promise that never settles cannot be
 * caught, only outrun — so the case that matters most here is the one a
 * try/catch test would never reach.
 */
describe('withTimeBudget', () => {
  test('a promise that NEVER settles resolves as a timeout', async () => {
    const outcome = await withTimeBudget(new Promise<void>(() => {}), 5);
    expect(outcome).toEqual({ status: 'timeout' });
  });

  test('a resolved promise hands back its value', async () => {
    expect(await withTimeBudget(Promise.resolve(42), 5)).toEqual({
      status: 'settled',
      value: 42,
    });
  });

  test('a REJECTED promise is reported, never thrown', async () => {
    // The caller decides what a failure means. Rethrowing here would just move
    // the `try` somewhere else.
    const boom = new Error('boom');
    expect(await withTimeBudget(Promise.reject(boom), 5)).toEqual({
      status: 'failed',
      error: boom,
    });
  });

  test('work that settles inside the budget is not delayed by the budget', async () => {
    const started = Date.now();
    const outcome = await withTimeBudget(Promise.resolve('fast'), 10_000);
    expect(outcome).toEqual({ status: 'settled', value: 'fast' });
    // Would be 10s if the timer were awaited rather than cleared.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a late settle after a timeout changes nothing', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(await withTimeBudget(slow, 5)).toEqual({ status: 'timeout' });
    release();
    await slow;
    // No throw, no unhandled rejection, no second resolution.
    expect(true).toBe(true);
  });

  test('the default budget is 2s', () => {
    expect(DEFAULT_TIME_BUDGET_MS).toBe(2000);
  });
});
