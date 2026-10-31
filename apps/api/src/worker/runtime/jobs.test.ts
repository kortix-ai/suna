import { afterEach, expect, mock, test } from 'bun:test';

const config = { KORTIX_WORKERS_ENABLED: true };
mock.module('../../config', () => ({ config }));
mock.module('../jobs', () => ({ JOBS: [] }));
mock.module('./heartbeat', () => ({ startJobHeartbeat: () => ({ stop() {}, report: () => [] }) }));
const { startJobs, stopJobs } = await import('./jobs');

const events: string[] = [];

function job(name: string, drainMs = 0) {
  return {
    ticks: [name],
    start: () => void events.push(`start ${name}`),
    stop: () => {
      events.push(`stop ${name}`);
      if (drainMs === 0) return;
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          events.push(`drained ${name}`);
          resolve();
        }, drainMs),
      );
    },
  };
}

afterEach(async () => {
  await stopJobs();
  config.KORTIX_WORKERS_ENABLED = true;
  events.length = 0;
});

test('starts every job once per term, in registry order', async () => {
  const jobs = [job('a'), job('b')];
  await startJobs(jobs);
  await startJobs(jobs);
  expect(events).toEqual(['start a', 'start b']);
});

test('every stop runs before the first drain is awaited (2026-10-16 lease-flap outage)', async () => {
  await startJobs([job('slow', 20), job('after-slow')]);
  events.length = 0;
  await stopJobs();
  expect(events).toEqual(['stop slow', 'stop after-slow', 'drained slow']);
});

test('a re-acquire after a release starts every job again', async () => {
  const jobs = [job('a')];
  await startJobs(jobs);
  await stopJobs();
  await startJobs(jobs);
  expect(events).toEqual(['start a', 'stop a', 'start a']);
});

test('starts nothing when background workers are disabled', async () => {
  config.KORTIX_WORKERS_ENABLED = false;
  await startJobs([job('a')]);
  expect(events).toEqual([]);
});
