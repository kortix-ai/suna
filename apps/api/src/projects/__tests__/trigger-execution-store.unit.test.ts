// markTriggerExecutionFailed() — `terminal` override for PERMANENT rejections.
//
// The prod gap this closes (incident-20260907T005210Z-monitors): a trigger fire
// rejected by the billing gate ("team wallet is out of credits") went through
// `markTriggerExecutionFailed` with NO way to say "permanent" — so the execution
// was retried five times over ~30s, each attempt re-running `createSession` →
// `checkBillingActive` → the atomic-hold `deductCredits` only to fail identically.
// The failure only became visible (and distinguishable) after the full retry
// ladder. Passing `terminal: true` dead-letters on the FIRST failure so the
// trigger runtime row shows `failed` + the machine-readable reason immediately.
//
// Mocks `../../shared/db` via `mock.module` — process-global in bun:test, so run
// this file in its own `bun test <file>` invocation, same caveat as
// ../session-lifecycle/__tests__/dead-letter-marks-session-failed.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectTriggerExecutions } from '@kortix/db';
import type { TriggerExecutionRow } from '../trigger-execution-store';

let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

mock.module('../../shared/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => {
          updateCalls.push({ table, updates });
          return { then: (resolve: (v: unknown) => void) => resolve(undefined) };
        },
      }),
    }),
  },
}));

const { markTriggerExecutionFailed } = await import('../trigger-execution-store');

const baseRow = (overrides: Record<string, unknown> = {}) =>
  ({
    executionId: 'exec-1',
    projectId: 'proj-1',
    slug: 'monitor',
    scheduleRevision: 'a'.repeat(64),
    scheduledFor: new Date('2026-09-05T12:39:00.000Z'),
    status: 'running',
    attempts: 1,
    ...overrides,
  }) as TriggerExecutionRow;

beforeEach(() => {
  updateCalls = [];
});

describe('markTriggerExecutionFailed — terminal override', () => {
  test('a PERMANENT rejection dead-letters on the first attempt when terminal is set', async () => {
    const result = await markTriggerExecutionFailed({
      row: baseRow({ attempts: 1 }),
      failedAt: new Date('2026-09-05T12:39:01.000Z'),
      error: 'Your team wallet is out of credits. Top up to keep your agents running.',
      terminal: true,
    });

    expect(result).toBe('dead_lettered');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.table).toBe(projectTriggerExecutions);
    expect(updateCalls[0]!.updates.status).toBe('dead_lettered');
    expect(updateCalls[0]!.updates.completedAt).toEqual(new Date('2026-09-05T12:39:01.000Z'));
    expect(updateCalls[0]!.updates.lastError).toContain('out of credits');
  });

  test('without terminal, an early failure still retries (attempts < 5 → queued)', async () => {
    const result = await markTriggerExecutionFailed({
      row: baseRow({ attempts: 2 }),
      failedAt: new Date('2026-09-05T12:39:01.000Z'),
      error: 'transient hiccup',
    });

    expect(result).toBe('queued');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.updates.status).toBe('queued');
  });

  test('without terminal, the 5th attempt still dead-letters', async () => {
    const result = await markTriggerExecutionFailed({
      row: baseRow({ attempts: 5 }),
      failedAt: new Date('2026-09-05T12:39:01.000Z'),
      error: 'transient hiccup',
    });

    expect(result).toBe('dead_lettered');
    expect(updateCalls[0]!.updates.status).toBe('dead_lettered');
  });
});
