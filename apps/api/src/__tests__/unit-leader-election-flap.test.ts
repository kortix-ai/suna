/**
 * A lease flap while the leader's workers stop (2026-10-16 prod): a blocked event loop passed the
 * renew deadline, the watchdog demoted, and the next lease tick re-acquired at once. onAcquire ran
 * while onRelease still awaited a slow stop: the bootstrap guard let it start, but each worker
 * stopped after that await was still "started", so its start did nothing, and then onRelease
 * stopped it. The worker stayed off for the whole term. The lease query is faked; time is fake.
 */
import { afterAll, expect, jest, mock, test } from 'bun:test';

let lease: 'ours' | 'hang' = 'ours';
const fakeSql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const insert = strings.join('').includes('INSERT');
    const query = (insert && lease === 'hang' ? new Promise(() => {}) : Promise.resolve(insert ? [{ owner_id: values[1] }] : [])) as Promise<unknown> & { cancel(): void };
    query.cancel = () => {};
    return query;
  },
  { unsafe: async () => [], end: async () => {} },
);
mock.module('postgres', () => ({ default: () => fakeSql }));

const { config } = await import('../config');
const { startLeaderElection, stopLeaderElection } = await import('../shared/leader-election');

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
/** Fake time in 1 s steps, letting promise chains settle between steps. */
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 1_000) {
    jest.advanceTimersByTime(1_000);
    await flush();
  }
};

afterAll(() => jest.useRealTimers());

test('a re-acquire while onRelease still awaits leaves every worker running', async () => {
  jest.useFakeTimers();
  config.DATABASE_URL = 'postgres://fake';
  // The bootstrap shape: a guard flag, and idempotent workers; the stop awaits between workers.
  const worker = () => {
    let on = false;
    return { start: () => void (on = true), stop: () => void (on = false), get on() { return on; } };
  };
  const early = worker();
  const late = worker();
  let running = false;
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
  startLeaderElection({
    onAcquire: async () => {
      if (running) return;
      running = true;
      early.start();
      late.start();
    },
    onRelease: async () => {
      if (!running) return;
      running = false;
      early.stop();
      await stopGate; // a worker whose stop awaits its in-flight tick
      late.stop();
    },
  });
  await flush();
  expect([early.on, late.on]).toEqual([true, true]);

  // The renews hang (a blocked event loop has the same effect): the watchdog demotes at 50 s.
  lease = 'hang';
  await advance(52_000);
  expect(early.on).toBe(false);
  // The lease tick re-acquires while onRelease still awaits.
  lease = 'ours';
  await advance(16_000);
  releaseStop();
  await flush();
  expect([running, early.on, late.on]).toEqual([true, true, true]);

  await stopLeaderElection();
});
