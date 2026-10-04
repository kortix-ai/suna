/**
 * The scheduled-account-deletion worker.
 *
 * `processScheduledDeletions()` existed with tests but no caller since the
 * schema moved to `kortix` (KRTX-1260): the only wired processor was the
 * legacy pg_cron job, whose SQL read the pre-baseline `public` copy of
 * `account_deletion_requests`. These tests pin the wiring: start() runs the
 * first tick immediately (the leader drains the backlog it inherits), gated
 * on the same billing flag as the deletion routes, ticks are serialized and
 * stop() awaits the tick in flight.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const actualConfig = await import('../config');
const ORIGINAL_BILLING_ENABLED = actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED;

type ProcessorResult = { processed: number; errors: string[] };

let processorCalls = 0;
let processor: () => Promise<ProcessorResult> = async () => ({ processed: 0, errors: [] });

mock.module('../billing/services/account-deletion', () => ({
  processScheduledDeletions: async () => processor(),
}));

const { startAccountDeletionSchedule, stopAccountDeletionSchedule } = await import(
  '../billing/account-deletion-schedule'
);

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

beforeEach(() => {
  processorCalls = 0;
  processor = async () => ({ processed: 0, errors: [] });
  actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = true;
});

afterAll(async () => {
  await stopAccountDeletionSchedule();
  actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = ORIGINAL_BILLING_ENABLED;
});

describe('startAccountDeletionSchedule', () => {
  test('the started worker executes the due deletions on its first tick', async () => {
    processor = async () => {
      processorCalls += 1;
      return { processed: 3, errors: [] };
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the first tick');
    await stopAccountDeletionSchedule();
    expect(processorCalls).toBe(1);
  });

  test('a failing tick is contained, not an unhandled rejection', async () => {
    processor = async () => {
      processorCalls += 1;
      throw new Error('db unavailable');
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the failing first tick');
    await expect(stopAccountDeletionSchedule()).resolves.toBeUndefined();
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
  });

  test('billing disabled schedules nothing', async () => {
    actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = false;
    startAccountDeletionSchedule();
    await Bun.sleep(50);
    expect(processorCalls).toBe(0);
    await stopAccountDeletionSchedule();
  });

  test('stop awaits the tick in flight and no tick fires after stop', async () => {
    let release: () => void = () => {};
    processor = async () => {
      processorCalls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { processed: 1, errors: [] };
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the first tick');
    const stopped = stopAccountDeletionSchedule();
    release();
    await stopped;
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
  });

  test('a second start while running does not double-schedule', async () => {
    processor = async () => {
      processorCalls += 1;
      return { processed: 0, errors: [] };
    };
    startAccountDeletionSchedule();
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the single first tick');
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
    await stopAccountDeletionSchedule();
  });
});
