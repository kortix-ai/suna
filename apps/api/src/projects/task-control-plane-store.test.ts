import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASK_BLOCKER_REMINDER_DEFAULT_INTERVAL_MS,
  TASK_BLOCKER_REMINDER_MAX_INTERVAL_MS,
  TASK_BLOCKER_REMINDER_MIN_INTERVAL_MS,
  hasActiveTaskSideEffectFence,
  sweepExpiredProjectTaskCoordinatorClaims,
  taskBlockerReminderIntervalMs,
  taskBlockerReminderText,
} from './task-control-plane-store';

describe('task blocker reminder policy', () => {
  test('treats every admission and Git write field as a cancellation fence', () => {
    const settled = {
      livenessAdmissionId: null,
      livenessAdmissionExpiresAt: null,
      gitWriteRequestId: null,
      gitWriteLeaseExpiresAt: null,
      gitWriteState: null,
      gitWriteRef: null,
      gitWriteOldOid: null,
      gitWriteNewOid: null,
    };
    expect(hasActiveTaskSideEffectFence(settled)).toBe(false);
    for (const key of Object.keys(settled) as Array<keyof typeof settled>) {
      expect(
        hasActiveTaskSideEffectFence({
          ...settled,
          [key]: key.endsWith('At') ? new Date('2026-08-09T14:00:00.000Z') : 'active',
        }),
      ).toBe(true);
    }
  });

  test('defaults and clamps the configured interval', () => {
    expect(taskBlockerReminderIntervalMs({})).toBe(TASK_BLOCKER_REMINDER_DEFAULT_INTERVAL_MS);
    expect(taskBlockerReminderIntervalMs({ reminder_interval_seconds: 1 })).toBe(
      TASK_BLOCKER_REMINDER_MIN_INTERVAL_MS,
    );
    expect(taskBlockerReminderIntervalMs({ reminder_interval_seconds: 3_600 })).toBe(3_600_000);
    expect(taskBlockerReminderIntervalMs({ reminder_interval_seconds: 99_999_999 })).toBe(
      TASK_BLOCKER_REMINDER_MAX_INTERVAL_MS,
    );
  });

  test('renders the exact blocker without an unbounded prompt', () => {
    const text = taskBlockerReminderText({
      blockerId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      category: 'credential',
      requestedAction: `Grant access ${'x'.repeat(20_000)}`,
      target: { service: 'Google Workspace' },
      expiresAt: new Date('2026-08-10T12:00:00.000Z'),
    });
    expect(text).toContain('Required human action: Grant access');
    expect(text).toContain('Google Workspace');
    expect(text).toContain('2026-08-10T12:00:00.000Z');
    expect(text.length).toBeLessThan(13_000);
  });

  test('uses the existing leader-owned trigger and lifecycle drain', () => {
    const source = readFileSync(join(import.meta.dir, 'lib', 'triggers.ts'), 'utf8');
    expect(source).toContain('sweepDueProjectTaskBlockerReminders(db, now, 100)');
    expect(source).toContain('sweepExpiredProjectTaskCoordinatorClaims(db, now, 100)');
    expect(source).toContain('drainSessionLifecycleQueue({ limit: 10 })');
  });

  test('rejects an invalid abandoned-claim sweep limit before database access', async () => {
    await expect(
      sweepExpiredProjectTaskCoordinatorClaims({} as never, new Date(), 0),
    ).rejects.toThrow('limit must be an integer between 1 and 1000');
  });

  test('selects expired blockers independently and wakes the latest coordinator', () => {
    const source = readFileSync(join(import.meta.dir, 'task-control-plane-store.ts'), 'utf8');
    expect(source).toContain('lte(projectTaskBlockers.expiresAt, now)');
    expect(source.match(/desc\(projectTaskSessionLinks\.createdAt\)/g)).toHaveLength(2);
  });
});
