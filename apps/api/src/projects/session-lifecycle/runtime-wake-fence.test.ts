import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_START_FAILURE_TTL_MS,
  RUNTIME_START_MAX_FAILURES,
  RUNTIME_WAKE_GRACE_MS,
  RUNTIME_WAKE_HARD_MS,
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

/** A fake sleep that advances a virtual clock. */
function virtualClock() {
  const clock = { ms: 0, sleep: async (ms: number) => void (clock.ms += ms) };
  return clock;
}

describe('waitForRuntimeWakeRunning', () => {
  test('stops polling when the provider reports removed', async () => {
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'removed';
      },
      { sleep: async () => {} },
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
      waitOptions: { sleep: async () => {} },
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
      waitOptions: { sleep: async () => {} },
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
      waitOptions: { sleep: async () => {} },
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
    const steady = runtimeWakePollDelayMs(1_000);
    const rampLength = Array.from({ length: 50 }, (_, i) => runtimeWakePollDelayMs(i)).indexOf(steady);
    expect(rampLength).toBeGreaterThan(0);
    // The ramp never spends more than the flat poll it replaced, or a slow wake
    // pays more provider calls than before; past the ramp the poll is flat.
    for (let i = 0; i < rampLength; i += 1) {
      expect(runtimeWakePollDelayMs(i)).toBeLessThan(steady);
      if (i > 0) expect(runtimeWakePollDelayMs(i)).toBeGreaterThanOrEqual(runtimeWakePollDelayMs(i - 1));
    }
    for (let i = rampLength; i < rampLength + 5; i += 1) {
      expect(runtimeWakePollDelayMs(i)).toBe(steady);
    }
  });

  test('a VM that comes up mid-ramp is caught by the first short delay', async () => {
    const statuses = ['stopped', 'running'];
    let calls = 0;
    const slept: number[] = [];
    const running = await waitForRuntimeWakeRunning(
      async () => statuses[calls++] ?? 'running',
      { sleep: async (ms) => { slept.push(ms); } },
    );
    expect(running).toBe(true);
    expect(slept).toEqual([150]);
  });

  test('a wake with no provider-state change ends at the no-progress grace', async () => {
    const clock = virtualClock();
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'stopped';
      },
      { sleep: clock.sleep },
    );
    expect(running).toBe(false);
    // The delay that would overrun the grace is never slept.
    expect(clock.ms).toBeLessThan(RUNTIME_WAKE_GRACE_MS);
    expect(clock.ms + runtimeWakePollDelayMs(calls - 1)).toBeGreaterThanOrEqual(
      RUNTIME_WAKE_GRACE_MS,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Progress-aware wake budget + the stamped-failure cooldown ladder.
// Incident 2026-08-26: two prod sessions.
// ───────────────────────────────────────────────────────────────────────────

describe('waitForRuntimeWakeRunning — progress-aware budget', () => {
  test('a wake whose provider state keeps changing is NOT killed at the no-progress grace', async () => {
    // 14m11s E2B template rebuild, 2026-08-26. The old fixed 90s budget gave up
    // on a box that was still advancing. Each state here lasts 60 s, inside the
    // grace, and the whole wake lasts 180 s, twice the grace.
    const clock = virtualClock();
    const statusAt = (ms: number) =>
      ms < 60_000 ? 'stopped' : ms < 120_000 ? 'restoring' : ms < 180_000 ? 'starting' : 'running';
    const running = await waitForRuntimeWakeRunning(async () => statusAt(clock.ms), {
      sleep: clock.sleep,
    });
    expect(running).toBe(true);
    expect(clock.ms).toBeGreaterThanOrEqual(180_000);
  });

  test('the hard cap ends a wake whose provider status flaps forever', async () => {
    const clock = virtualClock();
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => (calls++ % 2 === 0 ? 'stopped' : 'starting'),
      { sleep: clock.sleep },
    );
    expect(running).toBe(false);
    // Bounded by the ceiling, even though every read was "progress".
    expect(clock.ms).toBeGreaterThan(RUNTIME_WAKE_GRACE_MS);
    expect(clock.ms).toBeLessThan(RUNTIME_WAKE_HARD_MS);
  });

  test('onProgress fires once per DISTINCT status and a throw never ends the wake', async () => {
    const statuses = ['stopped', 'stopped', 'starting', 'running'];
    let calls = 0;
    const seen: string[] = [];
    const running = await waitForRuntimeWakeRunning(async () => statuses[calls++] ?? 'running', {
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
  const at = (ms: number) => new Date(started.getTime() + ms);
  const wake = (leaseMs: number) => ({
    runtimeWakeId: 'wake-1',
    runtimeWakeStartedAt: started.toISOString(),
    runtimeWakeLeaseExpiresAt: at(leaseMs).toISOString(),
  });

  // The fence is what the reconcile gate and the compute-close policy read, so
  // it must hold for the whole lease and must expire at the ceiling whatever
  // the lease says.
  test.each([
    ['at the claim', wake(RUNTIME_WAKE_LEASE_MS), 0, true],
    ['1 s in', wake(RUNTIME_WAKE_LEASE_MS), 1_000, true],
    ['half way through the lease', wake(RUNTIME_WAKE_LEASE_MS), 120_000, true],
    ['at the last lease instant', wake(RUNTIME_WAKE_LEASE_MS), RUNTIME_WAKE_LEASE_MS, true],
    ['1 ms past the lease', wake(RUNTIME_WAKE_LEASE_MS), RUNTIME_WAKE_LEASE_MS + 1, false],
    // Past the 240 s age fallback, so only the extended lease answers true.
    ['past the age fallback, inside an extended lease', wake(60 * 60_000), 5 * 60_000, true],
    ['inside the ceiling on an hour-long lease', wake(60 * 60_000), 9 * 60_000, true],
    ['past the ceiling on an hour-long lease', wake(60 * 60_000), RUNTIME_WAKE_HARD_MS + 1, false],
  ] as const)('%s: %p', (_label, metadata, elapsedMs, open) => {
    expect(runtimeWakeInProgress(metadata, at(elapsedMs))).toBe(open);
  });

  test('progress refreshes the lease, and only for the wake that owns the row', () => {
    const metadata = {
      runtimeWakeId: 'wake-1',
      runtimeWakeStartedAt: started.toISOString(),
      runtimeWakeProviderStatus: 'starting',
      runtimeWakeLeaseExpiresAt: new Date(started.getTime() + 240_000).toISOString(),
    };
    const observedAt = new Date(started.getTime() + 200_000);
    expect(runtimeWakeProgressPatch(metadata, 'starting', observedAt)).toBeNull();
    const patch = runtimeWakeProgressPatch(metadata, 'restoring', observedAt);
    expect(patch?.runtimeWakeProviderStatus).toBe('restoring');
    expect(patch?.runtimeWakeLeaseExpiresAt).toBe(
      new Date(observedAt.getTime() + RUNTIME_WAKE_LEASE_MS).toISOString(),
    );
    // The ceiling is measured from the start, so progress never moves it.
    expect(patch).not.toHaveProperty('runtimeWakeStartedAt');
    // No claim id ⇒ no lease to extend.
    expect(runtimeWakeProgressPatch({ runtimeWakeStartedAt: started.toISOString() }, 'x', observedAt)).toBeNull();
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

  test.each(['runtime_wake_failed', 'runtime_boot_failed'])(
    '%s: inside the cooldown it defers; past the cooldown the next /start RE-ATTEMPTS',
    (stopReason) => {
      const stamp = { ...base, stopReason };
      expect(stampedRuntimeFailureState(stamp, new Date(failedAt.getTime() + 119_000))).toBe(
        'cooling_down',
      );
      expect(stampedRuntimeFailureState(stamp, new Date(failedAt.getTime() + 121_000))).toBe(
        'retry',
      );
    },
  );

  test('THE INCIDENT: a 10-hour-old stamp is never replayed', () => {
    // A prod session: `runtime_boot_failed` stamped 03:37Z answered every
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
