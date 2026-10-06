import { afterEach, expect, mock, test } from 'bun:test';
let drains = 0;
let drainMs = 0;
let concurrent = 0;
let maxConcurrent = 0;
const config = { KORTIX_TRIGGER_SCHEDULER_ENABLED: true };
mock.module('../../config', () => ({ config }));
let listening = false;
let dueHandler: ((dueAtMs: number) => void) | null = null;
mock.module('../../shared/pg-broadcast', () => ({
  isPgBroadcastListening: () => listening,
  onLifecycleCommandDue: (handler: ((dueAtMs: number) => void) | null) => {
    dueHandler = handler;
  },
}));
mock.module('./drain', () => ({
  drainSessionLifecycleQueue: async () => {
    drains++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (drainMs > 0) await Bun.sleep(drainMs);
    concurrent--;
    return {};
  },
}));
const { startSessionLifecycleWorker, stopSessionLifecycleWorker } = await import('./worker');
const { wakeAt, DRAIN_FALLBACK_MS, MIN_DRAIN_GAP_MS } = await import('../../workers/session-lifecycle-worker');
afterEach(async () => {
  stopSessionLifecycleWorker();
  await Bun.sleep(drainMs + 20);
  drainMs = 0;
  listening = false;
});

test('delivery starts without cron leadership and recurring retries stop cleanly', async () => {
  drains = 0;
  startSessionLifecycleWorker();
  expect(drains).toBe(1);
  await Bun.sleep(1_050);
  expect(drains).toBe(2);
  stopSessionLifecycleWorker();
  await Bun.sleep(1_050);
  expect(drains).toBe(2);
});

test('restarting replaces the previous interval', async () => {
  drains = 0;
  startSessionLifecycleWorker();
  await Bun.sleep(10);
  startSessionLifecycleWorker();
  expect(drains).toBe(2);
  await Bun.sleep(1_050);
  expect(drains).toBe(3);
});

test('a drain slower than the interval never overlaps the next tick', async () => {
  // A drain delivers prompts over the network (~1.3 s). Overlapping ticks
  // stacked unbounded drains on every API task and starved the DB pool.
  //
  // WAIT for the second drain instead of sleeping a fixed 3_200 ms. The old
  // form left a 200 ms margin: drain 1 runs 0 -> 2_500, the 1_000 ms ticks at
  // 1_000 and 2_000 are correctly skipped, and drain 2 can only start at the
  // 3_000 ms tick — 200 ms before the assertion. A loaded runner delays a
  // timer past that easily, and this test then reports `drains === 1` for a
  // worker that is behaving perfectly. It failed exactly that way on `main`
  // (run 35257494646, 5_886 ms for a 3_200 ms test) while `worker.ts` was
  // untouched. The learnings register's rule is a 5x margin between the paced
  // event and the budget asserted; polling removes the margin question
  // entirely.
  //
  // Both invariants still hold, and they are the point of the test: drains
  // never overlap (`maxConcurrent === 1`), and a 2_500 ms drain under a
  // 1_000 ms interval yields exactly 2 drains, never a stack of skipped
  // ticks firing at once. The deadline only bounds the failure.
  drains = 0;
  maxConcurrent = 0;
  drainMs = 2_500;
  startSessionLifecycleWorker();
  const deadline = Date.now() + 20_000;
  while (drains < 2 && Date.now() < deadline) await Bun.sleep(25);
  expect(maxConcurrent).toBe(1);
  expect(drains).toBe(2);
});

test('an explicitly disabled background scheduler does not start delivery retries', async () => {
  config.KORTIX_TRIGGER_SCHEDULER_ENABLED = false;
  drains = 0;
  startSessionLifecycleWorker();
  expect(drains).toBe(0);
  config.KORTIX_TRIGGER_SCHEDULER_ENABLED = true;
});

test('a due time wakes the drain at that moment, never sooner than the gap after the last drain', () => {
  const now = 100_000;
  expect(wakeAt(now + 3_000, now - 5_000, now)).toBe(now + 3_000);
  expect(wakeAt(now, now - 200, now)).toBe(now - 200 + MIN_DRAIN_GAP_MS);
  expect(wakeAt(now - 60_000, 0, now)).toBe(now);
  expect(wakeAt(now + 60 * 60_000, 0, now)).toBeNull();
});

test('with the LISTEN live, the tick is only a fallback and a NOTIFY wakes the drain', async () => {
  listening = true;
  drains = 0;
  startSessionLifecycleWorker();
  expect(drains).toBe(1);
  await Bun.sleep(1_200);
  // No 1 s poll while the LISTEN is live.
  expect(drains).toBe(1);
  dueHandler?.(Date.now());
  const deadline = Date.now() + 5_000;
  while (drains < 2 && Date.now() < deadline) await Bun.sleep(25);
  expect(drains).toBe(2);
});

test('a storm of NOTIFYs drains at most once per gap', async () => {
  listening = true;
  drains = 0;
  startSessionLifecycleWorker();
  const until = Date.now() + 2_100;
  while (Date.now() < until) {
    dueHandler?.(Date.now());
    await Bun.sleep(20);
  }
  // 1 at start + one per MIN_DRAIN_GAP_MS over ~2.1 s.
  expect(drains).toBeGreaterThanOrEqual(2);
  expect(drains).toBeLessThanOrEqual(3);
});

test('the fallback tick drains when no NOTIFY came for the fallback window', async () => {
  listening = true;
  drains = 0;
  startSessionLifecycleWorker();
  const deadline = Date.now() + DRAIN_FALLBACK_MS + 3_000;
  while (drains < 2 && Date.now() < deadline) await Bun.sleep(50);
  expect(drains).toBe(2);
}, 15_000);
