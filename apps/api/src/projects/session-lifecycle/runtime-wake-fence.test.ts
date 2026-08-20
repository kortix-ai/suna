import { describe, expect, test } from 'bun:test';
import {
  executeClaimedRuntimeWake,
  runtimeWakeInProgress,
  runtimeWakePollDelayMs,
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

// ── Latency: the resume path must not buy the same answer twice, and must not
// sit on an already-running VM waiting out a flat poll tick. ───────────────
describe('wake latency', () => {
  test('knownStatus skips the pre-start provider round trip entirely', async () => {
    let statusCalls = 0;
    let started = 0;
    const result = await executeClaimedRuntimeWake({
      knownStatus: 'stopped',
      getStatus: async () => {
        statusCalls += 1;
        return 'running';
      },
      start: async () => {
        started += 1;
      },
      stop: async () => {},
      finalize: async () => true,
      fail: async () => true,
      claimState: async () => 'owned',
      waitOptions: { graceMs: 3_000, pollMs: 1, sleep: async () => {} },
    });

    expect(result).toBe('running');
    expect(started).toBe(1);
    // Exactly one — the confirmation poll. The pre-check is gone, not merely
    // faster: a second call here is the regression this test exists to catch.
    expect(statusCalls).toBe(1);
  });

  test('a knownStatus of running finalizes without starting or polling at all', async () => {
    let statusCalls = 0;
    let started = 0;
    const result = await executeClaimedRuntimeWake({
      knownStatus: 'running',
      getStatus: async () => {
        statusCalls += 1;
        return 'running';
      },
      start: async () => {
        started += 1;
      },
      stop: async () => {},
      finalize: async () => true,
      fail: async () => true,
      claimState: async () => 'owned',
    });

    expect(result).toBe('running');
    expect(started).toBe(0);
    expect(statusCalls).toBe(0);
  });

  test('omitting knownStatus preserves the original pre-check', async () => {
    let statusCalls = 0;
    const result = await executeClaimedRuntimeWake({
      getStatus: async () => {
        statusCalls += 1;
        return 'running';
      },
      start: async () => {},
      stop: async () => {},
      finalize: async () => true,
      fail: async () => true,
      claimState: async () => 'owned',
    });

    expect(result).toBe('running');
    expect(statusCalls).toBe(1);
  });

  test('the poll ramp checks early, then decays to the flat steady cadence', () => {
    expect(runtimeWakePollDelayMs(0)).toBe(150);
    expect(runtimeWakePollDelayMs(1)).toBe(250);
    expect(runtimeWakePollDelayMs(2)).toBe(400);
    expect(runtimeWakePollDelayMs(3)).toBe(600);
    expect(runtimeWakePollDelayMs(4)).toBe(1_000);
    expect(runtimeWakePollDelayMs(50)).toBe(1_000);
    // The ramp must never spend more than the flat poll it replaced, or a slow
    // wake pays more provider calls than before.
    for (let i = 0; i < 4; i += 1) expect(runtimeWakePollDelayMs(i)).toBeLessThan(1_000);
  });

  test('a VM that comes up mid-ramp is caught by the first short delay', async () => {
    const statuses = ['stopped', 'running'];
    let calls = 0;
    const slept: number[] = [];
    const running = await waitForRuntimeWakeRunning(
      async () => statuses[calls++] ?? 'running',
      { graceMs: 90_000, sleep: async (ms) => { slept.push(ms); } },
    );
    expect(running).toBe(true);
    expect(slept).toEqual([150]);
  });

  test('the ramp still honours the grace budget as a deadline', async () => {
    let clock = 0;
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'stopped';
      },
      {
        graceMs: 500,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(running).toBe(false);
    // 150 + 250 fits inside 500ms; the 400 that would overrun is not slept.
    expect(clock).toBe(400);
    expect(calls).toBe(3);
  });
});
