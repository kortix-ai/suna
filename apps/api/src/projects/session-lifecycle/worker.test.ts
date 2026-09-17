import { afterEach, expect, mock, test } from 'bun:test';
let drains = 0;
let drainMs = 0;
let concurrent = 0;
let maxConcurrent = 0;
const config = { KORTIX_TRIGGER_SCHEDULER_ENABLED: true };
mock.module('../../config', () => ({ config }));
mock.module('./engine', () => ({
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
  drains = 0;
  maxConcurrent = 0;
  drainMs = 2_500;
  startSessionLifecycleWorker();
  await Bun.sleep(3_200);
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
