import { describe, expect, test } from 'bun:test';
import {
  PROJECT_SESSIONS_POLL_MAX_MS,
  PROJECT_SESSIONS_POLL_MS,
  nextProjectSessionsPollWindow,
  projectSessionsPollInterval,
} from './poll-policy';

const row = (session_id: string, status: string) => ({ session_id, status });

describe('projectSessionsPollInterval', () => {
  test('constants: 3 s poll, capped at 4 min', () => {
    expect(PROJECT_SESSIONS_POLL_MS).toBe(3_000);
    expect(PROJECT_SESSIONS_POLL_MAX_MS).toBe(240_000);
  });

  test('polls every 3 s while a row is queued, branching or provisioning', () => {
    for (const status of ['queued', 'branching', 'provisioning']) {
      expect(projectSessionsPollInterval([row('a', 'running'), row('b', status)], 1_000, 1_000)).toBe(
        3_000
      );
    }
  });

  test('does not poll when no row is pending', () => {
    expect(projectSessionsPollInterval([row('a', 'running'), row('b', 'failed')], 0, 0)).toBe(false);
    expect(projectSessionsPollInterval([], 0, 0)).toBe(false);
    expect(projectSessionsPollInterval(undefined, 0, 0)).toBe(false);
  });

  test('stops 4 min after the poll started', () => {
    const rows = [row('a', 'provisioning')];
    expect(projectSessionsPollInterval(rows, 10_000, 10_000 + 239_999)).toBe(3_000);
    expect(projectSessionsPollInterval(rows, 10_000, 10_000 + 240_000)).toBe(false);
    expect(projectSessionsPollInterval(rows, 10_000, 10_000 + 600_000)).toBe(false);
  });
});

describe('nextProjectSessionsPollWindow', () => {
  test('no window without pending rows', () => {
    expect(nextProjectSessionsPollWindow(null, [row('a', 'running')], 5)).toBeNull();
    expect(nextProjectSessionsPollWindow({ key: 'a', startedAt: 1 }, [], 5)).toBeNull();
    expect(nextProjectSessionsPollWindow(null, undefined, 5)).toBeNull();
  });

  test('starts a window at `now` for a new pending set', () => {
    expect(nextProjectSessionsPollWindow(null, [row('b', 'queued'), row('a', 'provisioning')], 7)).toEqual({
      key: 'a,b',
      startedAt: 7,
    });
  });

  test('keeps the start time while the same rows stay pending', () => {
    const prev = { key: 'a,b', startedAt: 7 };
    const next = nextProjectSessionsPollWindow(
      prev,
      [row('a', 'branching'), row('c', 'running'), row('b', 'provisioning')],
      99_000
    );
    expect(next).toBe(prev);
  });

  test('restarts the window when the pending set changes', () => {
    expect(
      nextProjectSessionsPollWindow({ key: 'a', startedAt: 7 }, [row('a', 'provisioning'), row('b', 'queued')], 50)
    ).toEqual({ key: 'a,b', startedAt: 50 });
  });
});
