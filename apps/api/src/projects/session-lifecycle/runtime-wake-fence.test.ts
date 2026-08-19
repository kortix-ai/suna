import { describe, expect, test } from 'bun:test';
import {
  executeClaimedRuntimeWake,
  runtimeWakeInProgress,
  waitForRuntimeWakeRunning,
} from './runtime-wake-fence';

describe('waitForRuntimeWakeRunning', () => {
  test('keeps the wake fence after start acceptance until the provider reports running', async () => {
    const statuses = ['stopped', 'stopped', 'running'];
    let calls = 0;
    let sleeps = 0;

    const running = await waitForRuntimeWakeRunning(async () => statuses[calls++] ?? 'running', {
      graceMs: 3_000,
      pollMs: 1_000,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(running).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toBe(2);
  });

  test('returns false when the transition never reaches running', async () => {
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'stopped';
      },
      { graceMs: 3_000, pollMs: 1_000, sleep: async () => {} },
    );

    expect(running).toBe(false);
    expect(calls).toBe(3);
  });

  test('stops polling when the provider reports removed', async () => {
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'removed';
      },
      { graceMs: 90_000, pollMs: 1_000, sleep: async () => {} },
    );

    expect(running).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('executeClaimedRuntimeWake', () => {
  test('a hard start rejection never finalizes billing state', async () => {
    let finalized = 0;
    const failures: string[] = [];
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => 'stopped',
      start: async () => {
        throw new Error('provider rejected start');
      },
      stop: async () => {},
      finalize: async () => {
        finalized += 1;
        return true;
      },
      fail: async (reason) => {
        failures.push(reason);
        return true;
      },
      claimState: async () => 'owned',
    });

    expect(result).toBe('failed');
    expect(finalized).toBe(0);
    expect(failures).toEqual(['start_failed']);
  });

  test('a start timeout is ambiguous and finalizes once provider-running appears', async () => {
    const statuses = ['stopped', 'stopped', 'running'];
    let finalized = 0;
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => statuses.shift() ?? 'running',
      start: async () => {
        throw new Error('platinum POST /start timed out');
      },
      stop: async () => {},
      finalize: async () => {
        finalized += 1;
        return true;
      },
      fail: async () => true,
      claimState: async () => 'owned',
      waitOptions: { graceMs: 2_000, pollMs: 1_000, sleep: async () => {} },
    });

    expect(result).toBe('running');
    expect(finalized).toBe(1);
  });

  test('a start timeout that never reaches provider-running fails without real-time waiting', async () => {
    let finalized = 0;
    const failures: string[] = [];
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => 'stopped',
      start: async () => {
        throw new Error('platinum POST /start timed out');
      },
      stop: async () => {},
      finalize: async () => {
        finalized += 1;
        return true;
      },
      fail: async (reason) => {
        failures.push(reason);
        return true;
      },
      claimState: async () => 'owned',
      waitOptions: { graceMs: 3, pollMs: 1, sleep: async () => {} },
    });

    expect(result).toBe('failed');
    expect(finalized).toBe(0);
    expect(failures).toEqual(['start_timeout']);
  });

  test('manual stop wins a late provider-running completion', async () => {
    let stops = 0;
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => 'running',
      start: async () => {},
      stop: async () => {
        stops += 1;
      },
      finalize: async () => false,
      fail: async () => false,
      claimState: async () => 'cancelled',
    });

    expect(result).toBe('cancelled');
    expect(stops).toBe(1);
  });

  test('a newer wake claim owns the late completion without being stopped', async () => {
    let stops = 0;
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => 'running',
      start: async () => {},
      stop: async () => {
        stops += 1;
      },
      finalize: async () => false,
      fail: async () => false,
      claimState: async () => 'delegated',
    });

    expect(result).toBe('delegated');
    expect(stops).toBe(0);
  });
});

test('runtimeWakeInProgress uses the durable lease expiry', () => {
  const now = new Date('2026-08-08T20:00:00.000Z');
  expect(
    runtimeWakeInProgress(
      {
        runtimeWakeId: 'wake-1',
        runtimeWakeStartedAt: '2026-08-08T19:00:00.000Z',
        runtimeWakeLeaseExpiresAt: '2026-08-08T20:00:01.000Z',
      },
      now,
    ),
  ).toBe(true);
});
