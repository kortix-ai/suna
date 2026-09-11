import { afterEach, describe, expect, test } from 'bun:test';
import type { BudgetReportState } from './budget-report-policy';
import { reconcileSnapshotQuota, type SnapshotQuotaIo } from './quota-gc';
import { DAYTONA_ORG_SNAPSHOT_LIMIT } from './quota-gc-select';

// The policy itself is unit-tested in budget-report-policy.test.ts. What is
// asserted HERE is that the GC pass actually consults it. It did not: the
// import and the state were both dead, so `[snapshot-gc] BUDGET UNRESOLVED`
// still went out on every pass -- 1,936 lines in seven days on prod -- and the
// fix shipped as decoration. CodeQL caught it as an unused import.

const NOW = Date.parse('2026-09-10T00:00:00Z');
const HOUR_MS = 60 * 60_000;

/**
 * Every snapshot is referenced, so nothing is eligible for eviction. Over the
 * org limit with no candidates is exactly the unresolvable-budget condition.
 */
function overBudgetIo(): SnapshotQuotaIo {
  const names = Array.from(
    { length: DAYTONA_ORG_SNAPSHOT_LIMIT + 20 },
    (_unused, index) => `kortix-tpl-referenced-${index}`,
  );
  return {
    isConfigured: () => true,
    listSnapshots: async () =>
      names.map((name, index) => ({
        id: `id-${index}`,
        name,
        state: 'started',
        createdAt: new Date(NOW - 30 * 86_400_000).toISOString(),
        lastUsedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
      })),
    loadReferencedSnapshotNames: async () => new Set(names),
    deleteSnapshotById: async () => true,
  };
}

const originalError = console.error;
afterEach(() => {
  console.error = originalError;
});

function captureAlarms(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return lines;
}

async function pass(state: BudgetReportState, nowMs: number): Promise<void> {
  await reconcileSnapshotQuota({ dryRun: true, now: nowMs, budgetState: state }, overBudgetIo());
}

describe('the snapshot budget alarm is edge-triggered, not per-pass', () => {
  test('speaks once when the condition arrives, then stays quiet', async () => {
    const state: BudgetReportState = { lastReportedAtMs: null };
    const alarms = captureAlarms();

    await pass(state, NOW);
    expect(alarms.filter((line) => line.includes('BUDGET UNRESOLVED'))).toHaveLength(1);

    // Four more passes a few minutes apart, the real GC cadence.
    for (let i = 1; i <= 4; i++) await pass(state, NOW + i * 4 * 60_000);
    expect(alarms.filter((line) => line.includes('BUDGET UNRESOLVED'))).toHaveLength(1);
  });

  test('speaks again after an hour so a long incident cannot go silent', async () => {
    const state: BudgetReportState = { lastReportedAtMs: null };
    const alarms = captureAlarms();

    await pass(state, NOW);
    await pass(state, NOW + HOUR_MS - 1_000);
    expect(alarms.filter((line) => line.includes('BUDGET UNRESOLVED'))).toHaveLength(1);

    await pass(state, NOW + HOUR_MS);
    expect(alarms.filter((line) => line.includes('BUDGET UNRESOLVED'))).toHaveLength(2);
  });

  test('a pass that is not over budget says nothing while the condition was never seen', async () => {
    const state: BudgetReportState = { lastReportedAtMs: null };
    const alarms = captureAlarms();

    const quiet: SnapshotQuotaIo = {
      isConfigured: () => true,
      listSnapshots: async () => [],
      loadReferencedSnapshotNames: async () => new Set<string>(),
      deleteSnapshotById: async () => true,
    };
    await reconcileSnapshotQuota({ dryRun: true, now: NOW, budgetState: state }, quiet);

    expect(alarms).toHaveLength(0);
    expect(state.lastReportedAtMs).toBeNull();
  });
});
