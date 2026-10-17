import { describe, expect, test } from 'bun:test';

import {
  BAR_COUNT,
  BAR_MIN_PCT,
  canReplay,
  parsePayload,
  relativeRunTime,
  runBars,
  runState,
  runTone,
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

describe('relativeRunTime', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  test('reads in the given locale', () => {
    expect(relativeRunTime('2026-10-17T11:59:30.000Z', 'en', now)).toBe('now');
    expect(relativeRunTime('2026-10-17T11:55:00.000Z', 'en', now)).toBe('5 minutes ago');
    expect(relativeRunTime('2026-10-17T09:00:00.000Z', 'en', now)).toBe('3 hours ago');
    expect(relativeRunTime('2026-10-16T12:00:00.000Z', 'en', now)).toBe('yesterday');
    expect(relativeRunTime('2026-10-17T11:55:00.000Z', 'de', now)).toBe('vor 5 Minuten');
  });

  test('an unparsable time renders nothing', () => {
    expect(relativeRunTime('nope', 'en', now)).toBe('');
  });
});

describe('runBars', () => {
  const run = (
    status: 'fired' | 'failed' | 'rejected' | 'skipped' | 'queued' | 'running',
    duration_ms: number | null,
    run_status: 'succeeded' | 'failed' | 'running' | null = null,
  ) => ({ status, run_status, duration_ms });

  test('oldest on the left, scaled to the longest run, with a floor', () => {
    // The API lists newest first.
    const bars = runBars([
      run('fired', 120_000, 'succeeded'),
      run('failed', 1_000),
      run('fired', 60_000, 'succeeded'),
    ]);
    expect(bars.map((b) => b.pct)).toEqual([50, BAR_MIN_PCT, 100]);
  });

  test('a run without a duration, or all zero, draws the floor', () => {
    expect(runBars([run('queued', null), run('running', null)]).map((b) => b.pct)).toEqual([
      BAR_MIN_PCT,
      BAR_MIN_PCT,
    ]);
    expect(runBars([run('skipped', 0)])[0]!.pct).toBe(BAR_MIN_PCT);
  });

  test('draws at most the latest 30 runs', () => {
    const many = Array.from({ length: 45 }, (_, i) => run('fired', i + 1, 'succeeded'));
    const bars = runBars(many);
    expect(bars).toHaveLength(BAR_COUNT);
    // The newest run (index 0) is the rightmost bar.
    expect(bars[BAR_COUNT - 1]!.run).toBe(many[0]!);
  });

  test('colour follows the state the row shows', () => {
    expect(
      runBars([
        run('fired', 1, 'succeeded'),
        run('fired', 1, null),
        run('fired', 1, 'running'),
        run('fired', 1, 'failed'),
        run('failed', 1),
        run('rejected', 1),
        run('skipped', 1),
        run('queued', 1),
      ])
        .reverse()
        .map((b) => b.tone),
    ).toEqual(['green', 'green', 'green', 'red', 'red', 'orange', 'muted', 'yellow']);
    expect(runTone('running')).toBe('green');
  });
});
