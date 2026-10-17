import { describe, expect, test } from 'bun:test';

import { canReplay, parsePayload, runState, runsInFlight } from './trigger-runs-logic';

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
  test('failed and rejected runs with a whole payload', () => {
    expect(canReplay({ status: 'failed', payload: {} })).toBe(true);
    expect(canReplay({ status: 'rejected', payload: { body: {} } })).toBe(true);
  });

  test('not a truncated payload, not a run that fired', () => {
    expect(canReplay({ status: 'failed', payload: { truncated: true, bytes: 70000 } })).toBe(false);
    expect(canReplay({ status: 'fired', payload: {} })).toBe(false);
    expect(canReplay({ status: 'skipped', payload: {} })).toBe(false);
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
