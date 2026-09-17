import { afterEach, expect, mock, test } from 'bun:test';
let drains = 0;
const config = { KORTIX_TRIGGER_SCHEDULER_ENABLED: true };
mock.module('../../config', () => ({ config }));
mock.module('./engine', () => ({ drainSessionLifecycleQueue: async () => { drains++; return {}; } }));
const { startSessionLifecycleWorker, stopSessionLifecycleWorker } = await import('./worker');
afterEach(stopSessionLifecycleWorker);

test('delivery starts without cron leadership and recurring retries stop cleanly', async () => {
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
  startSessionLifecycleWorker();
  expect(drains).toBe(2);
  await Bun.sleep(1_050);
  expect(drains).toBe(3);
});

test('an explicitly disabled background scheduler does not start delivery retries', async () => {
  config.KORTIX_TRIGGER_SCHEDULER_ENABLED = false;
  drains = 0;
  startSessionLifecycleWorker();
  expect(drains).toBe(0);
  config.KORTIX_TRIGGER_SCHEDULER_ENABLED = true;
});
