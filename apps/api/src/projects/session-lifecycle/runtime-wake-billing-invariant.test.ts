/**
 * REGRESSION GUARD for the two money/turn invariants the wake fence carries.
 * Read this before changing `runtimeWakeInProgress` or anything that consumes
 * it (reaping/sandbox-state-sync.ts, reaping/box-reaper.ts,
 * billing/services/compute-close-policy.ts, reaping/parked-runtime-verification.ts).
 *
 * INVARIANT 1 — no mid-turn park on one observation (2026-08-17T20:40:03Z,
 * session 0fc6897a, Daytona f468056d). Daytona folds `stopping` and
 * `pending_stop` into `stopped`, so ONE unsolicited `stopped` read is not
 * proof. A second read, one confirmation window later, is.
 *
 * INVARIANT 2 — no phantom billing across a wake. A provider can keep
 * answering `stopped` while `start()` is still changing the VM, so reconcile
 * must not convert that transitional read into a durable Kortix stop: doing so
 * closes the compute meter and records a later provider-RUNNING VM as stopped.
 * The wake fence is the exemption that prevents it.
 *
 * The 2026-08-26 change made the fence PROGRESS-AWARE (a lease refreshed by a
 * provider-state change) and added an absolute ceiling. Both directions are
 * pinned here:
 *   - inside the old 240s window the fence answers exactly as before, so the
 *     exemption is never narrowed and no park can happen earlier than today;
 *   - the exemption now ENDS at `RUNTIME_WAKE_HARD_MS`, so an extended lease
 *     can never hold the meter — or the reconcile — open forever.
 */

import { describe, expect, test } from 'bun:test';
import { decideComputeClose } from '../../billing/services/compute-close-policy';
import {
  MIDTURN_STOP_CONFIRMATION_MS,
  decideStoppedObservation,
} from '../reaping/sandbox-state-sync';
import {
  RUNTIME_WAKE_HARD_MS,
  RUNTIME_WAKE_LEASE_MS,
  runtimeWakeInProgress,
  runtimeWakeProgressPatch,
  stampedRuntimeFailureState,
} from './runtime-wake-fence';

const STARTED = new Date('2026-08-26T10:00:00.000Z');
const at = (ms: number) => new Date(STARTED.getTime() + ms);

const openWake = {
  runtimeWakeId: 'wake-1',
  runtimeWakeStartedAt: STARTED.toISOString(),
  runtimeWakeProviderStatus: 'starting',
  runtimeWakeLeaseExpiresAt: at(RUNTIME_WAKE_LEASE_MS).toISOString(),
};

describe('INVARIANT 1 — one observation never parks a box that holds a turn', () => {
  // `activeTurns` is a map keyed by turn token (sandbox-turn-lifecycle.ts).
  const midTurn = {
    activeTurns: { 'turn-1': { token: 'turn-1', state: 'active', opencodeSessionId: 'ses_1' } },
  };

  test('the first stopped read only records; the park needs a second one', () => {
    expect(decideStoppedObservation(midTurn, at(0))).toBe('await_confirmation');
    const observed = { ...midTurn, pendingStopObservedAtMs: at(0).getTime() };
    expect(decideStoppedObservation(observed, at(MIDTURN_STOP_CONFIRMATION_MS - 1))).toBe(
      'await_confirmation',
    );
    expect(decideStoppedObservation(observed, at(MIDTURN_STOP_CONFIRMATION_MS))).toBe('park');
  });

  test('the confirmation window is unchanged by the wake-fence work', () => {
    expect(MIDTURN_STOP_CONFIRMATION_MS).toBe(60_000);
  });

  test('a box with no turn authority still parks on the first read', () => {
    expect(decideStoppedObservation({}, at(0))).toBe('park');
  });
});

describe('INVARIANT 2 — the wake exemption is never narrowed, and never unbounded', () => {
  test('inside the original 240s lease the fence answers exactly as before', () => {
    for (const ms of [0, 1_000, 120_000, RUNTIME_WAKE_LEASE_MS]) {
      expect(runtimeWakeInProgress(openWake, at(ms))).toBe(true);
    }
    expect(runtimeWakeInProgress(openWake, at(RUNTIME_WAKE_LEASE_MS + 1))).toBe(false);
  });

  test('the compute meter is NOT closed while a wake is open — the whole point', () => {
    const base = {
      sandboxStatus: 'active',
      hasProviderTarget: true,
      runtimeStartFailed: false,
      providerStatus: 'stopped' as const,
      unresolvedForMs: null,
      openForMs: 60_000,
      beyondLivenessCeiling: false,
      unresolvedCeilingMs: 15 * 60_000,
      maxWindowMs: 24 * 3_600_000,
    };
    expect(decideComputeClose({ ...base, wakeInProgress: true }).reason).toBeNull();
    // Without the exemption the same row closes as `provider-not-running`, and
    // a VM that comes up seconds later is recorded stopped and unbilled.
    expect(decideComputeClose({ ...base, wakeInProgress: false }).reason).toBe(
      'provider-not-running',
    );
  });

  test('a progress-extended lease still ends at the hard ceiling', () => {
    // A provider whose status flaps refreshes the lease on every change.
    let metadata: Record<string, unknown> = { ...openWake };
    for (let elapsed = 60_000; elapsed < 60 * 60_000; elapsed += 60_000) {
      const patch = runtimeWakeProgressPatch(
        metadata,
        elapsed % 120_000 === 0 ? 'starting' : 'stopped',
        at(elapsed),
      );
      if (patch) metadata = { ...metadata, ...patch };
    }
    // The lease itself is far in the future…
    expect(Date.parse(String(metadata.runtimeWakeLeaseExpiresAt))).toBeGreaterThan(
      at(RUNTIME_WAKE_HARD_MS).getTime(),
    );
    // …and the fence is closed anyway, so nothing stays exempt for ever.
    expect(runtimeWakeInProgress(metadata, at(RUNTIME_WAKE_HARD_MS - 1_000))).toBe(true);
    expect(runtimeWakeInProgress(metadata, at(RUNTIME_WAKE_HARD_MS + 1))).toBe(false);
  });

  test('progress NEVER moves runtimeWakeStartedAt — the ceiling cannot be reset', () => {
    const patch = runtimeWakeProgressPatch(openWake, 'restoring', at(120_000));
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty('runtimeWakeStartedAt');
  });
});

describe('the retry ladder cannot manufacture an active row', () => {
  test('a stamped failure only ever answers retry / cooling_down / terminal', () => {
    const stamped = {
      stopReason: 'runtime_wake_failed',
      runtimeStartFailedAt: STARTED.toISOString(),
      runtimeStartFailureCount: 1,
    };
    for (const ms of [0, 60_000, 130_000, 40 * 60_000]) {
      const state = stampedRuntimeFailureState(stamped, at(ms));
      expect(['retry', 'cooling_down', 'terminal']).toContain(state);
    }
  });

  test('a re-attempt is a WAKE, and a wake keeps the row stopped and unbilled', () => {
    // `retry` is permission for `resumeStoppedSandbox` to claim the fence. The
    // claim CASes on `status = 'stopped'` and leaves it stopped; only a
    // provider-RUNNING confirmation may flip the row active and open the meter
    // (routes/shared.ts `finalize`). So the ladder adds no path from a failed
    // start to a billed row — it only adds a path back to trying.
    const readyToRetry = {
      stopReason: 'runtime_boot_failed',
      runtimeStartFailedAt: STARTED.toISOString(),
      runtimeStartFailureCount: 1,
    };
    expect(stampedRuntimeFailureState(readyToRetry, at(130_000))).toBe('retry');
    // While that re-attempt runs, the fence is open again and the meter stays
    // exempt — the same protection the first attempt had.
    expect(runtimeWakeInProgress({ ...readyToRetry, ...openWake }, at(130_000))).toBe(true);
  });
});
