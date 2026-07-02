import { describe, expect, mock, test } from 'bun:test';

// maintenance.ts pulls in the real config module (which validates the real,
// dotenvx-encrypted process.env and calls process.exit on a bare `bun test`
// run — see the sibling sandbox-reaper.test.ts for the same pattern) plus a
// wide fan of DB/provider modules. `shouldForceResetStaleLock` is a pure
// function with none of that runtime surface, so everything below is purely
// to let the module load in isolation.
mock.module('../config', () => ({ config: {} }));
mock.module('@kortix/db', () => ({ projectSessions: {}, projects: {} }));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('./git', () => ({ deleteRemoteSessionBranch: async () => false }));
mock.module('../billing/services/compute-metering', () => ({ tickRunningComputeCharges: async () => ({ settled: 0 }) }));
mock.module('../snapshots/builder', () => ({ reconcileStaleBuilds: async () => ({ checked: 0, closedReady: 0, closedFailed: 0 }) }));
mock.module('../snapshots/quota-gc', () => ({ reconcileSnapshotQuota: async () => ({ namespaceCount: 0, eligible: 0, deleted: 0, dryRun: false }) }));
mock.module('./sandbox-reaper', () => ({
  reapAndReconcileSandboxes: async () => ({ candidates: 0, stopped: 0, reconciled: 0, billingClosed: 0, skipped: 0, errors: 0 }),
  reconcileOrphanComputeSessions: async () => ({ checked: 0, closed: 0, errors: 0 }),
  reconcileStuckActiveSessions: async () => ({ candidates: 0, reconciled: 0, billingClosed: 0, errors: 0 }),
  reapOrphanProviderBoxes: async () => ({ listed: 0, orphans: 0, stopped: 0, errors: 0 }),
  countBillingInvariantViolations: async () => 0,
}));

const { shouldForceResetStaleLock } = await import('./maintenance');

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
