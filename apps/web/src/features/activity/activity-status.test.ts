import { describe, expect, test } from 'bun:test';

import {
  formatRunDuration,
  isLiveRun,
  matchesRunStatus,
  runStatusLabel,
  runStatusTone,
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
});
