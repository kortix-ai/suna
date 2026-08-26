import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_START_FAILURE_TTL_MS,
  RUNTIME_START_MAX_FAILURES,
  RUNTIME_WAKE_LEASE_MS,
  executeClaimedRuntimeWake,
  runtimeStartFailurePatch,
  runtimeStartRetryDelayMs,
  runtimeWakeInProgress,
  runtimeWakePollDelayMs,
  runtimeWakeProgressPatch,
  stampedRuntimeFailureState,
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

test('runtimeWakeInProgress uses the durable lease expiry, not the age fallback', () => {
  const now = new Date('2026-08-08T20:00:00.000Z');
  // Started 5 minutes ago — past the 240s age fallback, inside the 10-minute
  // hard ceiling — so only the durable lease can be answering `true` here.
  expect(
    runtimeWakeInProgress(
      {
        runtimeWakeId: 'wake-1',
        runtimeWakeStartedAt: '2026-08-08T19:55:00.000Z',
        runtimeWakeLeaseExpiresAt: '2026-08-08T20:00:01.000Z',
      },
      now,
    ),
  ).toBe(true);
  // …and the ceiling outranks the lease: a wake that started an hour ago is
  // over whatever its (progress-extended) lease claims. See the hard-cap test.
  expect(
    runtimeWakeInProgress(
      {
        runtimeWakeId: 'wake-1',
        runtimeWakeStartedAt: '2026-08-08T19:00:00.000Z',
        runtimeWakeLeaseExpiresAt: '2026-08-08T20:00:01.000Z',
      },
      now,
    ),
  ).toBe(false);
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

// ───────────────────────────────────────────────────────────────────────────
// Progress-aware wake budget + the stamped-failure cooldown ladder.
// Incident 2026-08-26 (Essentia): sessions e06ad0c4 and 9c8749ac.
// ───────────────────────────────────────────────────────────────────────────

describe('waitForRuntimeWakeRunning — progress-aware budget', () => {
  test('a wake whose provider state keeps changing is NOT killed at the no-progress grace', async () => {
    // 14m11s E2B template rebuild, 2026-08-26. The old fixed 90s budget gave up
    // on a box that was still advancing.
    const statuses = ['stopped', 'stopped', 'restoring', 'restoring', 'starting', 'running'];
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(async () => statuses[calls++] ?? 'running', {
      graceMs: 3_000,
      pollMs: 1_000,
      hardCapMs: 600_000,
      sleep: async () => {},
    });
    expect(running).toBe(true);
    expect(calls).toBe(6);
  });

  test('the hard cap ends a wake whose provider status flaps forever', async () => {
    const flap = ['stopped', 'starting'];
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(async () => flap[calls++ % 2], {
      graceMs: 3_000,
      pollMs: 1_000,
      hardCapMs: 10_000,
      sleep: async () => {},
    });
    expect(running).toBe(false);
    // 10_000 / 1_000 — bounded, even though every read was "progress".
    expect(calls).toBe(10);
  });

  test('onProgress fires once per DISTINCT status and a throw never ends the wake', async () => {
    const statuses = ['stopped', 'stopped', 'starting', 'running'];
    let calls = 0;
    const seen: string[] = [];
    const running = await waitForRuntimeWakeRunning(async () => statuses[calls++] ?? 'running', {
      graceMs: 5_000,
      pollMs: 1_000,
      sleep: async () => {},
      onProgress: async (status) => {
        seen.push(status);
        throw new Error('metadata write failed');
      },
    });
    expect(running).toBe(true);
    expect(seen).toEqual(['stopped', 'starting']);
  });
});

describe('runtimeWakeInProgress — hard ceiling', () => {
  const started = new Date('2026-08-26T10:00:00.000Z');
  test('an extended lease still expires at RUNTIME_WAKE_HARD_MS', () => {
    const metadata = {
      runtimeWakeId: 'wake-1',
      runtimeWakeStartedAt: started.toISOString(),
      // A flapping provider kept refreshing this.
      runtimeWakeLeaseExpiresAt: new Date(started.getTime() + 60 * 60_000).toISOString(),
    };
    expect(runtimeWakeInProgress(metadata, new Date(started.getTime() + 9 * 60_000))).toBe(true);
    expect(runtimeWakeInProgress(metadata, new Date(started.getTime() + 11 * 60_000))).toBe(false);
  });

  test('progress refreshes the lease, and only for the wake that owns the row', () => {
    const metadata = {
      runtimeWakeId: 'wake-1',
      runtimeWakeStartedAt: started.toISOString(),
      runtimeWakeProviderStatus: 'starting',
      runtimeWakeLeaseExpiresAt: new Date(started.getTime() + 240_000).toISOString(),
    };
    const at = new Date(started.getTime() + 200_000);
    expect(runtimeWakeProgressPatch(metadata, 'starting', at)).toBeNull();
    const patch = runtimeWakeProgressPatch(metadata, 'restoring', at);
    expect(patch?.runtimeWakeProviderStatus).toBe('restoring');
    expect(patch?.runtimeWakeLeaseExpiresAt).toBe(
      new Date(at.getTime() + RUNTIME_WAKE_LEASE_MS).toISOString(),
    );
    // No claim id ⇒ no lease to extend.
    expect(runtimeWakeProgressPatch({ runtimeWakeStartedAt: started.toISOString() }, 'x', at)).toBeNull();
  });
});

describe('stampedRuntimeFailureState — a stamp is a cooldown, never a gravestone', () => {
  const failedAt = new Date('2026-08-26T03:37:00.000Z');
  const base = {
    stopReason: 'runtime_boot_failed',
    runtimeStartFailedAt: failedAt.toISOString(),
    runtimeStartFailureCount: 1,
    runtimeStartRetryAfterAt: new Date(failedAt.getTime() + 120_000).toISOString(),
  };

  test('no stamped stop reason ⇒ no verdict', () => {
    expect(stampedRuntimeFailureState({ stopReason: 'idle' }, failedAt)).toBeNull();
    expect(stampedRuntimeFailureState(null, failedAt)).toBeNull();
  });

  test('covers BOTH stamped variants', () => {
    for (const stopReason of ['runtime_wake_failed', 'runtime_boot_failed']) {
      expect(
        stampedRuntimeFailureState({ ...base, stopReason }, new Date(failedAt.getTime() + 60_000)),
      ).toBe('cooling_down');
    }
  });

  test('inside the cooldown it defers; past the cooldown the next /start RE-ATTEMPTS', () => {
    expect(stampedRuntimeFailureState(base, new Date(failedAt.getTime() + 119_000))).toBe(
      'cooling_down',
    );
    expect(stampedRuntimeFailureState(base, new Date(failedAt.getTime() + 121_000))).toBe('retry');
  });

  test('THE INCIDENT: a 10-hour-old stamp is never replayed', () => {
    // Session 9c8749ac: `runtime_boot_failed` stamped 03:37Z answered every
    // open until 14:00Z+ with stage:"failed" and no provider call.
    expect(stampedRuntimeFailureState(base, new Date(failedAt.getTime() + 10 * 3_600_000))).toBe(
      'retry',
    );
  });

  test('a stamp with no readable clock cannot hold a session hostage', () => {
    expect(stampedRuntimeFailureState({ stopReason: 'runtime_wake_failed' }, failedAt)).toBe(
      'retry',
    );
  });

  test('consecutive failures escalate the cooldown and finally earn a terminal card', () => {
    expect(runtimeStartRetryDelayMs(1)).toBe(120_000);
    expect(runtimeStartRetryDelayMs(2)).toBe(300_000);
    expect(runtimeStartRetryDelayMs(3)).toBe(600_000);
    expect(runtimeStartRetryDelayMs(9)).toBe(600_000);
    const spent = {
      ...base,
      runtimeStartFailureCount: RUNTIME_START_MAX_FAILURES,
      runtimeStartRetryAfterAt: failedAt.toISOString(),
    };
    expect(stampedRuntimeFailureState(spent, new Date(failedAt.getTime() + 60_000))).toBe(
      'terminal',
    );
    // …and even THAT verdict expires, so a session opened later starts clean.
    expect(
      stampedRuntimeFailureState(spent, new Date(failedAt.getTime() + RUNTIME_START_FAILURE_TTL_MS)),
    ).toBe('retry');
  });

  test('a provider that disowned the box is terminal without burning attempts', () => {
    expect(
      stampedRuntimeFailureState(
        { ...base, stopReason: 'runtime_wake_failed', runtimeWakeError: 'missing' },
        new Date(failedAt.getTime() + 200_000),
      ),
    ).toBe('terminal');
  });

  test('legacy rows carrying only stoppedAt still expire', () => {
    const legacy = { stopReason: 'runtime_wake_failed', stoppedAt: failedAt.toISOString() };
    expect(stampedRuntimeFailureState(legacy, new Date(failedAt.getTime() + 60_000))).toBe(
      'cooling_down',
    );
    expect(stampedRuntimeFailureState(legacy, new Date(failedAt.getTime() + 130_000))).toBe('retry');
  });
});

describe('runtimeStartFailurePatch', () => {
  const first = new Date('2026-08-26T03:37:00.000Z');
  test('counts consecutive failures and escalates the retry clock', () => {
    const one = runtimeStartFailurePatch({}, first);
    expect(one.runtimeStartFailureCount).toBe(1);
    expect(one.runtimeStartRetryAfterAt).toBe(new Date(first.getTime() + 120_000).toISOString());
    const second = new Date(first.getTime() + 200_000);
    const two = runtimeStartFailurePatch(one, second);
    expect(two.runtimeStartFailureCount).toBe(2);
    expect(two.runtimeStartRetryAfterAt).toBe(new Date(second.getTime() + 300_000).toISOString());
    // The CAS predicate resumeStoppedSandbox already reads stays in step.
    expect(two.runtimeWakeRetryAfterAt).toBe(two.runtimeStartRetryAfterAt);
  });

  test('an episode older than the TTL starts counting from one again', () => {
    const one = runtimeStartFailurePatch({}, first);
    const muchLater = new Date(first.getTime() + RUNTIME_START_FAILURE_TTL_MS + 1_000);
    expect(runtimeStartFailurePatch(one, muchLater).runtimeStartFailureCount).toBe(1);
  });
});
