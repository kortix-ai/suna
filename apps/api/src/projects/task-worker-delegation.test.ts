import { describe, expect, mock, test } from 'bun:test';

let workerState: 'bound' | 'spawned_unbound' | 'stale_runtime' | 'not_worker' = 'not_worker';
mock.module('./generated-state-store', () => ({
  projectTaskWorkerAdmissionState: async () => workerState,
}));

const { taskWorkerDelegationDenied } = await import('./task-worker-delegation');
const database = {} as never;

describe('task-worker delegation confinement', () => {
  test('allows a human principal', async () => {
    expect(
      await taskWorkerDelegationDenied(database, { callerSessionId: null, hasAgentGrant: false }),
    ).toBe(false);
  });

  test('allows an ordinary active project session', async () => {
    workerState = 'not_worker';
    expect(
      await taskWorkerDelegationDenied(database, {
        callerSessionId: 'ordinary',
        hasAgentGrant: true,
      }),
    ).toBe(false);
  });

  test('denies bound and reserved workers', async () => {
    workerState = 'bound';
    expect(
      await taskWorkerDelegationDenied(database, {
        callerSessionId: 'worker',
        hasAgentGrant: true,
      }),
    ).toBe(true);
    workerState = 'spawned_unbound';
    expect(
      await taskWorkerDelegationDenied(database, {
        callerSessionId: 'worker',
        hasAgentGrant: true,
      }),
    ).toBe(true);
    workerState = 'stale_runtime';
    expect(
      await taskWorkerDelegationDenied(database, {
        callerSessionId: 'stopped-session',
        hasAgentGrant: true,
      }),
    ).toBe(true);
  });

  test('denies a stale agent grant without a session identity', async () => {
    expect(
      await taskWorkerDelegationDenied(database, { callerSessionId: null, hasAgentGrant: true }),
    ).toBe(true);
  });
});
