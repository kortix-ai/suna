import { describe, expect, test } from 'bun:test';
import { mayRequeueFailedCreate } from './requeue-policy';

describe('mayRequeueFailedCreate', () => {
  test('a failure ALREADY RETURNED to the caller is never re-queued', () => {
    expect(
      mayRequeueFailedCreate({ answeredSynchronously: true, errorIsRetryable: true }),
    ).toBe(false);
  });

  test('a QUEUED failure retries transient errors — that is the point of the queue', () => {
    expect(
      mayRequeueFailedCreate({ answeredSynchronously: false, errorIsRetryable: true }),
    ).toBe(true);
  });

  test('a queued failure with a terminal error is not retried', () => {
    expect(
      mayRequeueFailedCreate({ answeredSynchronously: false, errorIsRetryable: false }),
    ).toBe(false);
  });

  test('retryability follows OWNERSHIP, not the error class', () => {
    // Same transient error, opposite answers — which is the whole rule.
    const transient = { errorIsRetryable: true };
    expect(mayRequeueFailedCreate({ ...transient, answeredSynchronously: true })).toBe(false);
    expect(mayRequeueFailedCreate({ ...transient, answeredSynchronously: false })).toBe(true);
  });
});
