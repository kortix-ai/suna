import { describe, expect, test } from 'bun:test';

import { createPendingGate } from './pending-gate';

describe('a gate that waits for a reactive flag to settle', () => {
  test('resolves immediately when nothing is pending', async () => {
    const gate = createPendingGate(false);

    await gate.settled();

    expect(gate.pending()).toBe(false);
  });

  /**
   * The project-home send path this exists for. `useProjectCanRun` reports
   * `isLoading` until `/projects/:id/detail` AND
   * `/billing/account-state` land. On the staging release gate those had
   * 4.5s and 5.9s left to run at the moment the user pressed Enter
   * (run 35242868705, trace of `27-desktop-parity.spec.ts`). Both send gates
   * read that flag and DROPPED the prompt — `throw new Error('Account access
   * is still loading')` and a bare `onError(); return`. Nothing retried, so
   * the prompt was lost. Waiting is the only correct answer: the account's
   * ability to run is knowable in a moment, and the user already committed.
   */
  test('holds until the flag settles, then resolves', async () => {
    const gate = createPendingGate(true);
    let resolved = false;

    const waiting = gate.settled().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.set(false);
    await waiting;

    expect(resolved).toBe(true);
  });

  test('releases every waiter on one settle', async () => {
    const gate = createPendingGate(true);
    const order: number[] = [];

    const all = Promise.all([
      gate.settled().then(() => order.push(1)),
      gate.settled().then(() => order.push(2)),
      gate.settled().then(() => order.push(3)),
    ]);

    gate.set(false);
    await all;

    expect(order).toEqual([1, 2, 3]);
  });

  test('a flag that goes pending again does not re-block a settled waiter', async () => {
    const gate = createPendingGate(true);
    gate.set(false);

    await gate.settled();

    gate.set(true);
    expect(gate.pending()).toBe(true);
  });

  test('a repeated settle is not an error and wakes nobody twice', async () => {
    const gate = createPendingGate(true);
    let wakes = 0;

    const waiting = gate.settled().then(() => {
      wakes += 1;
    });

    gate.set(false);
    gate.set(false);
    await waiting;

    expect(wakes).toBe(1);
  });

  /**
   * A send path must never wait forever. `useProjectCanRun` reports
   * `isLoading` until two queries land, and a query that retries for a long
   * time (or never resolves) would otherwise leave the composer wedged with
   * no toast and no way to try again — strictly worse than the refusal this
   * replaces. On timeout the caller keeps the old behaviour: refuse, and tell
   * the user.
   */
  test('gives up waiting after the timeout and reports that it never settled', async () => {
    const gate = createPendingGate(true);

    expect(await gate.settled(5)).toBe(false);
    expect(gate.pending()).toBe(true);
  });

  test('reports a real settle as settled', async () => {
    const gate = createPendingGate(true);
    setTimeout(() => gate.set(false), 1);

    expect(await gate.settled(200)).toBe(true);
  });

  test('an already-settled gate resolves true without waiting', async () => {
    const gate = createPendingGate(false);

    expect(await gate.settled(0)).toBe(true);
  });

  test('a timed-out waiter is dropped and does not wake later', async () => {
    const gate = createPendingGate(true);
    let wakes = 0;

    void gate.settled(5).then(() => {
      wakes += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes).toBe(1);

    gate.set(false);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(wakes).toBe(1);
  });

  test('setting the same pending value repeatedly keeps waiters blocked', async () => {
    const gate = createPendingGate(true);
    let resolved = false;
    void gate.settled().then(() => {
      resolved = true;
    });

    gate.set(true);
    gate.set(true);
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(gate.pending()).toBe(true);
  });
});
