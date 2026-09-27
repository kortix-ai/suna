import { afterEach, expect, mock, test } from 'bun:test';
let drains = 0;
let drainMs = 0;
let concurrent = 0;
let maxConcurrent = 0;
const config = { KORTIX_TRIGGER_SCHEDULER_ENABLED: true };
mock.module('../../config', () => ({ config }));
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
afterEach(async () => {
  stopSessionLifecycleWorker();
  await Bun.sleep(drainMs + 20);
  drainMs = 0;
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
