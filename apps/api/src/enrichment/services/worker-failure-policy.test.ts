import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EnrichmentError } from '../errors';

const failCalls: Array<{
  jobId: string;
  errorCode: string;
  message: string;
  deadLettered?: boolean;
}> = [];
const rescheduleCalls: Array<{ jobId: string; availableAt: Date; message: string }> = [];

mock.module('../repositories/jobs', () => ({
  claimDueJobs: async () => [],
  completeJob: async () => {},
  failJob: async (input: (typeof failCalls)[number]) => {
    failCalls.push(input);
  },
  rescheduleJob: async (input: (typeof rescheduleCalls)[number]) => {
    rescheduleCalls.push(input);
  },
}));

const { handleJobFailure } = await import('./worker');

function job(attempts: number) {
  return {
    jobId: 'job-1',
    accountId: 'acc-1',
    projectId: 'proj-1',
    createdBy: 'user-1',
    domain: 'example.com',
    idempotencyKey: 'proj-1:example.com',
    status: 'running',
    errorCode: null,
    lastError: null,
    attempts,
    availableAt: new Date(),
    lockedBy: 'worker',
    lockedUntil: new Date(),
    payload: {},
    result: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
  } as never;
}

beforeEach(() => {
  failCalls.length = 0;
  rescheduleCalls.length = 0;
});

afterEach(() => {
  failCalls.length = 0;
  rescheduleCalls.length = 0;
});

describe('handleJobFailure', () => {
  for (const code of ['invalid_domain', 'blocked', 'extraction_failed'] as const) {
    test(`records ${code} immediately without retrying`, async () => {
      await handleJobFailure(job(1), new EnrichmentError(code, `${code} happened`));

      expect(rescheduleCalls).toHaveLength(0);
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0].errorCode).toBe(code);
      expect(failCalls[0].deadLettered).toBeFalsy();
    });
  }

  test('never retries a permanent failure even on the first attempt', async () => {
    await handleJobFailure(job(0), new EnrichmentError('blocked', 'wall'));
    expect(rescheduleCalls).toHaveLength(0);
  });

  test('reschedules a transient failure with backoff', async () => {
    const before = Date.now();
    await handleJobFailure(job(1), new Error('connection reset'));

    expect(failCalls).toHaveLength(0);
    expect(rescheduleCalls).toHaveLength(1);
    expect(rescheduleCalls[0].availableAt.getTime()).toBeGreaterThan(before);
  });

  test('backs off further on the second attempt', async () => {
    await handleJobFailure(job(1), new Error('boom'));
    const first = rescheduleCalls[0].availableAt.getTime();
    rescheduleCalls.length = 0;

    await handleJobFailure(job(2), new Error('boom'));
    const second = rescheduleCalls[0].availableAt.getTime();

    expect(second).toBeGreaterThan(first);
  });

  test('dead-letters a transient failure once the budget is spent', async () => {
    await handleJobFailure(job(3), new Error('still broken'));

    expect(rescheduleCalls).toHaveLength(0);
    expect(failCalls[0].deadLettered).toBe(true);
  });

  test('retries a timeout once', async () => {
    await handleJobFailure(job(1), new EnrichmentError('timeout', 'too slow'));

    expect(failCalls).toHaveLength(0);
    expect(rescheduleCalls).toHaveLength(1);
  });

  test('fails a timeout on the second attempt rather than dead-lettering', async () => {
    await handleJobFailure(job(2), new EnrichmentError('timeout', 'too slow again'));

    expect(rescheduleCalls).toHaveLength(0);
    expect(failCalls[0].errorCode).toBe('timeout');
    expect(failCalls[0].deadLettered).toBe(false);
  });

  test('preserves the failure message for the status endpoint', async () => {
    await handleJobFailure(job(1), new EnrichmentError('blocked', 'cloudflare challenge'));
    expect(failCalls[0].message).toContain('cloudflare challenge');
  });

  test('treats a non-Error rejection as transient', async () => {
    await handleJobFailure(job(1), 'string failure');
    expect(rescheduleCalls).toHaveLength(1);
    expect(rescheduleCalls[0].message).toContain('string failure');
  });
});
