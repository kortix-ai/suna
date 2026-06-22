import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@/lib/projects-client';

import {
  formatRunDuration,
  formatUsd,
  isLiveRun,
  matchesRunStatus,
  runStatusLabel,
  runStatusTone,
  sortRuns,
} from './activity-status';

describe('activity-status', () => {
  test('maps terminal and live statuses to the right tone', () => {
    expect(runStatusTone('completed')).toBe('success');
    expect(runStatusTone('failed')).toBe('destructive');
    expect(runStatusTone('running')).toBe('info');
    expect(runStatusTone('provisioning')).toBe('warning');
    expect(runStatusTone('stopped')).toBe('neutral');
  });

  test('flags still-working runs and not terminal ones', () => {
    expect(isLiveRun('running')).toBe(true);
    expect(isLiveRun('provisioning')).toBe(true);
    expect(isLiveRun('queued')).toBe(true);
    expect(isLiveRun('completed')).toBe(false);
    expect(isLiveRun('failed')).toBe(false);
    expect(isLiveRun('stopped')).toBe(false);
  });

  test('humanizes status labels', () => {
    expect(runStatusLabel('provisioning')).toBe('Provisioning');
    expect(runStatusLabel('completed')).toBe('Completed');
    expect(runStatusLabel('failed')).toBe('Failed');
  });

  test('filters by outcome (running / failed / completed / all)', () => {
    expect(matchesRunStatus('running', 'running')).toBe(true);
    expect(matchesRunStatus('provisioning', 'running')).toBe(true);
    expect(matchesRunStatus('completed', 'running')).toBe(false);
    expect(matchesRunStatus('failed', 'failed')).toBe(true);
    expect(matchesRunStatus('completed', 'failed')).toBe(false);
    expect(matchesRunStatus('completed', 'completed')).toBe(true);
    expect(matchesRunStatus('failed', 'all')).toBe(true);
  });

  test('formats run duration deterministically', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    expect(formatRunDuration(t0, '2026-01-01T00:00:45.000Z')).toBe('45s');
    expect(formatRunDuration(t0, '2026-01-01T00:01:23.000Z')).toBe('1m 23s');
    expect(formatRunDuration(t0, '2026-01-01T02:05:00.000Z')).toBe('2h 5m');
    expect(formatRunDuration(t0, t0)).toBeNull();
    expect(formatRunDuration('2026-01-01T00:01:00.000Z', t0)).toBeNull();
  });

  test('formats USD with extra precision for cheap runs', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(0.123)).toBe('$0.123');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  test('sortRuns orders by recency, cost, or duration', () => {
    const mk = (id: string, created: string, updated: string) =>
      ({ session_id: id, created_at: created, updated_at: updated }) as unknown as ProjectSession;
    const a = mk('a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z'); // 30s
    const b = mk('b', '2026-01-02T00:00:00Z', '2026-01-02T00:10:00Z'); // 10m, newest
    const c = mk('c', '2026-01-01T12:00:00Z', '2026-01-01T12:01:00Z'); // 1m
    const runs = [a, b, c];
    const cost = (id: string) => ({ a: 5, b: 1, c: 2 })[id] ?? 0;

    expect(sortRuns(runs, 'recent', cost).map((r) => r.session_id)).toEqual(['b', 'c', 'a']);
    expect(sortRuns(runs, 'cost', cost).map((r) => r.session_id)).toEqual(['a', 'c', 'b']);
    expect(sortRuns(runs, 'duration', cost).map((r) => r.session_id)).toEqual(['b', 'c', 'a']);
  });
});
