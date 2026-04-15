import { afterEach, describe, expect, test } from 'bun:test';
import { coerceStaleUpdateStatus, reconcileRecoveredUpdateStatus } from '../update/status';
import type { UpdateStatus } from '../update/types';

const BASE_STATUS: UpdateStatus = {
  phase: 'verifying',
  progress: 80,
  message: 'Verifying new container...',
  targetVersion: '0.8.41',
  previousVersion: '0.8.40',
  currentVersion: '0.8.40',
  error: null,
  startedAt: '2026-04-15T01:20:00.000Z',
  updatedAt: '2026-04-15T01:28:21.502Z',
  backupId: null,
  diagnostics: {},
};

const originalSandboxVersion = process.env.SANDBOX_VERSION;

afterEach(() => {
  if (originalSandboxVersion === undefined) delete process.env.SANDBOX_VERSION;
  else process.env.SANDBOX_VERSION = originalSandboxVersion;
});

describe('coerceStaleUpdateStatus', () => {
  test('marks stale verifying updates as failed', () => {
    const result = coerceStaleUpdateStatus(BASE_STATUS, Date.parse('2026-04-15T01:32:30.000Z'));

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('stuck during verifying');
    expect(result.message).toContain('stuck in verifying');
  });

  test('leaves fresh updates alone', () => {
    const result = coerceStaleUpdateStatus(BASE_STATUS, Date.parse('2026-04-15T01:30:00.000Z'));

    expect(result).toBe(BASE_STATUS);
  });

  test('leaves terminal phases alone', () => {
    const complete = { ...BASE_STATUS, phase: 'complete' as const, progress: 100 };

    const result = coerceStaleUpdateStatus(complete, Date.parse('2026-04-15T02:00:00.000Z'));

    expect(result).toBe(complete);
  });
});

describe('reconcileRecoveredUpdateStatus', () => {
  test('marks cancelled backup updates as failed immediately', () => {
    const result = reconcileRecoveredUpdateStatus({
      ...BASE_STATUS,
      phase: 'backing_up',
      message: 'Cancelling backup and update…',
      cancelRequested: true,
    });

    expect(result.phase).toBe('failed');
    expect(result.progress).toBe(0);
    expect(result.message).toBe('Update cancelled before destructive changes started');
  });

  test('marks verifying updates complete after the new version boots', () => {
    process.env.SANDBOX_VERSION = '0.8.41';

    const result = reconcileRecoveredUpdateStatus(BASE_STATUS);

    expect(result.phase).toBe('complete');
    expect(result.progress).toBe(100);
    expect(result.currentVersion).toBe('0.8.41');
    expect(result.message).toBe('Updated to v0.8.41');
  });

  test('does not mark unrelated phases complete', () => {
    process.env.SANDBOX_VERSION = '0.8.41';

    const result = reconcileRecoveredUpdateStatus({ ...BASE_STATUS, phase: 'pulling' });

    expect(result.phase).toBe('pulling');
  });
});
