import { describe, expect, test } from 'bun:test';

import { isLiveRun, runStatusLabel, runStatusTone } from './activity-status';

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
});
