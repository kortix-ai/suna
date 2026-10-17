import { describe, expect, test } from 'bun:test';

import {
  bucketRuns,
  canReplay,
  inRunRange,
  isDefaultSource,
  parsePayload,
  runState,
  runsInFlight,
} from './trigger-runs-logic';

describe('runState', () => {
  test('a fire that did not fire keeps its status', () => {
    expect(runState({ status: 'failed', run_status: null })).toBe('failed');
    expect(runState({ status: 'rejected', run_status: null })).toBe('rejected');
    expect(runState({ status: 'skipped', run_status: null })).toBe('skipped');
    expect(runState({ status: 'queued', run_status: null })).toBe('queued');
    expect(runState({ status: 'running', run_status: null })).toBe('running');
  });

  test('a fired run reads the agent turn outcome', () => {
    expect(runState({ status: 'fired', run_status: 'running' })).toBe('running');
    expect(runState({ status: 'fired', run_status: 'succeeded' })).toBe('succeeded');
    expect(runState({ status: 'fired', run_status: 'failed' })).toBe('failed');
    expect(runState({ status: 'fired', run_status: null })).toBe('started');
  });
});

describe('runsInFlight', () => {
  test('polls while a run waits, runs, or its turn runs', () => {
    expect(runsInFlight([{ status: 'queued', run_status: null }])).toBe(true);
    expect(runsInFlight([{ status: 'running', run_status: null }])).toBe(true);
    expect(runsInFlight([{ status: 'fired', run_status: 'running' }])).toBe(true);
  });

  test('stops once every run is terminal', () => {
    expect(runsInFlight([])).toBe(false);
    expect(
      runsInFlight([
        { status: 'fired', run_status: 'succeeded' },
        { status: 'failed', run_status: null },
        { status: 'fired', run_status: null },
      ]),
    ).toBe(false);
  });
});

describe('canReplay', () => {
  test('every run that reads Failed or Rejected, with a whole payload', () => {
    expect(canReplay({ status: 'failed', run_status: null, payload: {} })).toBe(true);
    expect(canReplay({ status: 'rejected', run_status: null, payload: { body: {} } })).toBe(true);
    // A fire whose agent turn failed shows Failed, so it offers Replay too.
    expect(canReplay({ status: 'fired', run_status: 'failed', payload: {} })).toBe(true);
  });

  test('not a truncated payload, not a run that is in flight or went well', () => {
    expect(
      canReplay({ status: 'failed', run_status: null, payload: { truncated: true, bytes: 70000 } }),
    ).toBe(false);
    expect(canReplay({ status: 'fired', run_status: 'succeeded', payload: {} })).toBe(false);
    expect(canReplay({ status: 'fired', run_status: 'running', payload: {} })).toBe(false);
    expect(canReplay({ status: 'fired', run_status: null, payload: {} })).toBe(false);
    expect(canReplay({ status: 'running', run_status: null, payload: {} })).toBe(false);
    expect(canReplay({ status: 'skipped', run_status: null, payload: {} })).toBe(false);
  });
});

describe('parsePayload', () => {
  test('a JSON object parses', () => {
    expect(parsePayload('{"body": {"a": 1}}')).toEqual({ ok: true, value: { body: { a: 1 } } });
  });

  test('bad JSON and non-objects are refused', () => {
    expect(parsePayload('{body}')).toEqual({ ok: false, error: 'json' });
    expect(parsePayload('[]')).toEqual({ ok: false, error: 'object' });
    expect(parsePayload('null')).toEqual({ ok: false, error: 'object' });
    expect(parsePayload('3')).toEqual({ ok: false, error: 'object' });
  });
});

describe('bucketRuns', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 12, min)).toISOString();
  const run = (
    min: number,
    status: 'fired' | 'failed' | 'rejected' | 'skipped',
    duration_ms: number | null = null,
    cost_usd: number | null = null,
    run_status: 'succeeded' | 'failed' | null = null,
  ) => ({ started_at: at(min), status, run_status, duration_ms, cost_usd });

  test('equal slices from the oldest run to the newest; the last includes its end', () => {
    const buckets = bucketRuns(
      [
        run(0, 'fired', 1000, 0.1, 'succeeded'),
        run(5, 'failed'),
        run(10, 'fired', 3000, 0.2, 'succeeded'),
      ],
      2,
    );
    // 0 lands in the first slice; 5 (the boundary) and 10 (the end) in the last.
    expect(buckets.map((b) => b.total)).toEqual([1, 2]);
    expect(buckets[0]!.start).toBe(Date.parse(at(0)));
    expect(buckets[1]!.end).toBe(Date.parse(at(10)));
  });

  test('counts Failed and Rejected as failures, a fired run whose turn failed too', () => {
    const [b] = bucketRuns(
      [run(0, 'failed'), run(1, 'rejected'), run(2, 'fired', 1, null, 'failed'), run(3, 'skipped')],
      1,
    );
    expect(b!.failed).toBe(3);
  });

  test('median duration and summed cost per slice, nulls ignored', () => {
    const [b] = bucketRuns(
      [run(0, 'fired', 1000, 0.5), run(1, 'fired', 3000, null), run(2, 'fired', null, 0.25)],
      1,
    );
    expect(b!.medianMs).toBe(2000);
    expect(b!.cost).toBe(0.75);
  });

  test('no runs, no bars', () => {
    expect(bucketRuns([], 48)).toEqual([]);
  });

  test('inRunRange keeps the runs inside a bar window', () => {
    const r = run(5, 'fired');
    expect(inRunRange(r, null)).toBe(true);
    expect(inRunRange(r, { start: Date.parse(at(5)), end: Date.parse(at(6)) })).toBe(true);
    expect(inRunRange(r, { start: Date.parse(at(6)), end: Date.parse(at(7)) })).toBe(false);
  });
});

describe('isDefaultSource', () => {
  test('a run from the trigger’s own kind is the default; any other source is named', () => {
    expect(isDefaultSource('cron', 'cron')).toBe(true);
    expect(isDefaultSource('webhook', 'webhook')).toBe(true);
    expect(isDefaultSource('event', 'event')).toBe(true);
    expect(isDefaultSource('cron', 'manual')).toBe(false);
    expect(isDefaultSource('webhook', 'reminder')).toBe(false);
  });
});
