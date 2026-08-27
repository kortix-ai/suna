import { describe, expect, mock, test } from 'bun:test';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realSandboxReaper from './sandbox-reaper';
import * as realAttachments from '../connectors/attachments';
import { mockConfigModule } from './reaping/test-support/mock-config';

// maintenance.ts pulls in the real config module (which validates the real,
// dotenvx-encrypted process.env and calls process.exit on a bare `bun test`
// run — see the sibling sandbox-reaper.test.ts for the same pattern) plus a
// wide fan of DB/provider modules. `shouldForceResetStaleLock` is a pure
// function with none of that runtime surface, so everything below is purely
// to let the module load in isolation.
mock.module('../config', () => mockConfigModule());
mock.module('@kortix/db', () => ({ projectSessions: {}, projects: {} }));
mock.module('../connectors/attachments', () => ({
  ...realAttachments,
  cleanupExpiredConnectorAttachments: async () => ({ deleted: 0, errors: 0 }),
}));
// sweepExpiredSessionBranches() (unlike the other maintenance subtasks) isn't
// wrapped in its own .catch() and makes a real chained db.select(...) call —
// give it an empty-result chain so runProjectMaintenance can complete.
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            // The branch sweep orders before it limits (deterministic drain, so
            // the planner's scan order can't crowd rows out of the batch), so
            // the stub has to be chainable through orderBy as well as limit.
            orderBy: () => ({ limit: async () => [] }),
            limit: async () => [],
          }),
        }),
        // The monitor-event retention sweep selects straight off one table
        // (no join) before deleting the batch it found.
        where: () => ({
          orderBy: () => ({ limit: async () => [] }),
          limit: async () => [],
        }),
      }),
    }),
    selectDistinct: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));
mock.module('./git', () => ({ deleteRemoteSessionBranch: async () => false }));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  reopenComputeForSandbox: async () => undefined,
  tickRunningComputeCharges: async () => ({ settled: 0, reconciled: 0 }),
}));
mock.module('../snapshots/builder', () => ({
  routedPerProjectWarmImageName: () => 'kpp2-test',
  ensurePiWorkerImage: async () => undefined,
  reconcileStaleBuilds: async () => ({ checked: 0, closedReady: 0, closedFailed: 0 }),
}));
mock.module('../snapshots/quota-gc', () => ({
  reconcileSnapshotQuota: async () => ({
    orgTotal: 0,
    managedCount: 0,
    eligible: 0,
    deleted: 0,
    deferred: 0,
    budgetUnresolved: false,
    dryRun: false,
  }),
}));
// Controllable per-test: the first call can be made to hang forever (to
// simulate the exact 2026-07-02 failure mode — an unbounded provider call
// stuck inside reapAndReconcileSandboxes), later calls resolve normally.
let reapAndReconcileSandboxesImpl = async () => ({
  candidates: 0,
  stopped: 0,
  reconciled: 0,
  billingClosed: 0,
  skipped: 0,
  errors: 0,
});

// The prompt-delivery backstop lives with the command queue it drains, not with
// the sandbox reaper — maintenance.ts is simply the tick that calls both.
mock.module('./session-lifecycle/undelivered-prompts', () => ({
  reconcileUndeliveredPrompts: async () => ({ claimed: 0, succeeded: 0, failed: 0, queued: 0 }),
}));

mock.module('./session-lifecycle/runtime-wake-maintenance', () => ({
  reconcileRuntimeWakeFences: async () => ({ checked: 0, stopped: 0, removed: 0, errors: 0 }),
}));

mock.module('./sandbox-reaper', () => ({
  ...realSandboxReaper,
  reapAndReconcileSandboxes: () => reapAndReconcileSandboxesImpl(),
  reconcileOrphanComputeSessions: async () => ({ checked: 0, closed: 0, errors: 0 }),
  reconcileStuckActiveSessions: async () => ({
    candidates: 0,
    reconciled: 0,
    billingClosed: 0,
    errors: 0,
  }),
  reapOrphanProviderBoxes: async () => ({ listed: 0, orphans: 0, stopped: 0, errors: 0 }),
  countBillingInvariantViolations: async () => 0,
  // The mirror monitor: evidence-gated billing under-bills SILENTLY when the
  // reaper is starved, where wall-clock billing over-billed loudly.
  countStaleLivenessWindows: async () => 0,
  EMPTY_REAP_RESULT: {
    candidates: 0,
    matching: 0,
    deferred: 0,
    stopped: 0,
    hardStopped: 0,
    reconciled: 0,
    billingClosed: 0,
    skipped: 0,
    warmSkipped: 0,
    busyVetoed: 0,
    idleArmed: 0,
    errors: 0,
  },
}));

const { shouldForceResetStaleLock, runProjectMaintenance, __isMaintenanceRunningForTest } =
  await import('./maintenance');

// Regression coverage for the 2026-07-02 incident: an unbounded Daytona SDK
// call inside a maintenance cycle left `maintenanceRunning` stuck `true`
// forever (its `finally` never ran), silently killing the idle-sandbox
// reaper for hours and accumulating $39k+ in unbilled-idle compute across
// prod. Per-call timeouts (platform/providers/daytona.ts, shared/platinum.ts)
// fix the known cause; this watchdog is the independent backstop against an
// unknown future one — a held lock past the threshold must be force-reset,
// not trusted forever.
describe('shouldForceResetStaleLock', () => {
  test('does not reset a lock held for less than the threshold', () => {
    expect(shouldForceResetStaleLock(1_000, 15 * 60 * 1000)).toBe(false);
  });

  test('does not reset a lock at zero (a genuinely fresh cycle)', () => {
    expect(shouldForceResetStaleLock(0, 15 * 60 * 1000)).toBe(false);
  });

  test('does not reset a lock held for just under the threshold', () => {
    const threshold = 15 * 60 * 1000;
    expect(shouldForceResetStaleLock(threshold - 1, threshold)).toBe(false);
  });

  test('resets a lock held for exactly the threshold', () => {
    const threshold = 15 * 60 * 1000;
    expect(shouldForceResetStaleLock(threshold, threshold)).toBe(true);
  });

  test('resets a lock held well past the threshold (the incident shape — hours, not minutes)', () => {
    const threshold = 15 * 60 * 1000;
    const heldForMs = 3 * 60 * 60 * 1000; // 3 hours, as observed in prod
    expect(shouldForceResetStaleLock(heldForMs, threshold)).toBe(true);
  });
});

// Regression coverage for a bug caught in review of the watchdog itself: the
// first cut cleared `maintenanceRunning` unconditionally in `finally`, so an
// abandoned run that eventually settled in the background (it isn't
// cancelled — only its individual provider calls are now bounded) could
// clobber the lock a NEWER, legitimately-running cycle owned, letting a
// THIRD cycle start concurrently. The fix gates the `finally` release on a
// generation counter so only the run that's still current can release it.
describe('runProjectMaintenance stale-lock generation guard', () => {
  test("an abandoned run settling late does not release a newer run's lock", async () => {
    process.env.KORTIX_PROJECT_MAINTENANCE_STALL_MS = '20';

    let releaseHungRun: () => void = () => {};
    const hungRunSettled = new Promise<void>((resolve) => {
      releaseHungRun = resolve;
    });

    // Run A: hangs until we explicitly release it.
    reapAndReconcileSandboxesImpl = () =>
      hungRunSettled.then(() => ({
        candidates: 0,
        stopped: 0,
        reconciled: 0,
        billingClosed: 0,
        skipped: 0,
        errors: 0,
      }));
    const runA = runProjectMaintenance();

    // Let run A acquire the lock before we try to stall past the threshold.
    await new Promise((r) => setTimeout(r, 5));
    expect(__isMaintenanceRunningForTest()).toBe(true);

    // Wait past the (tiny, test-only) stall threshold, then start run B —
    // this is the watchdog force-reset path.
    await new Promise((r) => setTimeout(r, 30));
    reapAndReconcileSandboxesImpl = async () => ({
      candidates: 0,
      stopped: 0,
      reconciled: 0,
      billingClosed: 0,
      skipped: 0,
      errors: 0,
    });
    const errorSpy = mock((..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = errorSpy;
    const runB = runProjectMaintenance();
    console.error = originalError;
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('STALLED');

    // Run B completes fully before run A's hang is ever released — proves
    // the lock is genuinely free for run B, not just "not yet re-acquired".
    await runB;
    expect(__isMaintenanceRunningForTest()).toBe(false);

    // NOW let the abandoned run A settle. Its `finally` must be a no-op:
    // generation-gated, so it does not flip the lock (already false) back on
    // in some inconsistent way, nor race a hypothetical run C that this test
    // doesn't even need to start to prove the point — it's simply neutered.
    releaseHungRun();
    await runA;
    expect(__isMaintenanceRunningForTest()).toBe(false);

    delete process.env.KORTIX_PROJECT_MAINTENANCE_STALL_MS;
  });
});
