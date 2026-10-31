import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({ config: { INTERNAL_KORTIX_ENV: 'prod' } }));
mock.module('../../lib/logger', () => ({ logger: { warn() {}, info() {}, error() {} } }));
const { observeWorkerTicks, runWorkerTick } = await import('../../shared/audit-scope');
const { recordTickStart, staleTicks, startJobHeartbeat, STALE_FLOOR_MS } = await import('./heartbeat');

const MIN = 60_000;

afterEach(() => observeWorkerTicks(null));

describe('staleTicks', () => {
  test('a job is judged only after two tick starts', () => {
    const ticks = new Map([['once', recordTickStart(undefined, 0)]]);
    expect(staleTicks(ticks, 10 * 60 * MIN)).toEqual([]);
  });

  test('a 1-minute job is stale 10 minutes (the floor) after its last success', () => {
    const times = recordTickStart(recordTickStart(undefined, 0), MIN);
    times.lastOkAt = MIN;
    const ticks = new Map([['fast', times]]);
    expect(staleTicks(ticks, MIN + STALE_FLOOR_MS)).toEqual([]);
    expect(staleTicks(ticks, MIN + STALE_FLOOR_MS + 1)).toEqual(['fast']);
  });

  test('an hourly job is stale only after 3 of its intervals', () => {
    const times = recordTickStart(recordTickStart(undefined, 0), 60 * MIN);
    times.lastOkAt = 60 * MIN;
    const ticks = new Map([['hourly', times]]);
    expect(staleTicks(ticks, 60 * MIN + 179 * MIN)).toEqual([]);
    expect(staleTicks(ticks, 60 * MIN + 181 * MIN)).toEqual(['hourly']);
  });

  test('a job whose ticks keep failing is stale once its first start is past the limit', () => {
    const ticks = new Map([['failing', recordTickStart(recordTickStart(undefined, 0), MIN)]]);
    expect(staleTicks(ticks, STALE_FLOOR_MS + 1)).toEqual(['failing']);
  });
});

describe('startJobHeartbeat', () => {
  test('watches the registered jobs through runWorkerTick and writes one metric line', async () => {
    let now = 0;
    const lines: string[] = [];
    const heartbeat = startJobHeartbeat(
      [{ ticks: ['job-a'], start() {}, stop() {} }, { ticks: ['job-b'], start() {}, stop() {}, stalled: () => true }],
      { now: () => now, write: (line) => lines.push(line), intervalMs: 3_600_000 },
    );
    await runWorkerTick('job-a', async () => undefined);
    now = MIN;
    await runWorkerTick('job-a', async () => undefined);
    await runWorkerTick('not-a-job', async () => undefined);
    now = MIN + STALE_FLOOR_MS + 1;
    const stale = heartbeat.report();
    heartbeat.stop();

    expect(stale).toEqual(['job-a', 'job-b']);
    expect(JSON.parse(lines[0]!)).toEqual({
      kortix_metric: 'worker_jobs',
      environment: 'prod',
      stale_jobs: 2,
      jobs_seen: 1,
      stale: ['job-a', 'job-b'],
    });
  });

  test('a tick that throws does not count as a success, and stop() removes the observer', async () => {
    let now = 0;
    const heartbeat = startJobHeartbeat([{ ticks: ['job-a'], start() {}, stop() {} }], {
      now: () => now,
      write: () => {},
      intervalMs: 3_600_000,
    });
    await runWorkerTick('job-a', async () => undefined);
    now = MIN;
    await runWorkerTick('job-a', async () => {
      throw new Error('boom');
    }).catch(() => {});
    now = STALE_FLOOR_MS + 1;
    expect(heartbeat.report()).toEqual(['job-a']);
    heartbeat.stop();
    await runWorkerTick('job-a', async () => undefined);
    expect(heartbeat.report()).toEqual(['job-a']);
  });
});
