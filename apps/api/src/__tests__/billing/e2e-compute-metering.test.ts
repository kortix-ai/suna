// Billing v2 — end-to-end compute metering lifecycle.
//
// Exercises the full sandbox lifecycle through the metering service:
//   start → settle (partial) → pause → resume → finalize.
// Verifies that the credit_ledger gets the right `compute_debit` entries and
// the sandbox_compute_sessions audit table reflects each transition.
//
// Uses the existing billing mock registry to stub the repository layer; the
// metering service runs against those mocks for real, exercising the actual
// cost math, debit routing, and state transitions.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';
import {
  createMockCreditAccount,
  mockRegistry,
  registerGlobalMocks,
  resetMockRegistry,
  registerCreditsMock,
} from './mocks';

registerGlobalMocks();
registerCreditsMock();

// ─── Mock the compute-sessions + yolo repos used by compute-metering ─────────

interface InMemorySession {
  id: string;
  accountId: string;
  sandboxId: string;
  sessionId: string | null;
  actorUserId: string | null;
  provider: 'daytona' | 'platinum' | 'e2b';
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
  gpuCount: number;
  state: 'active' | 'stopped' | 'finalized';
  startedAt: string;
  endedAt: string | null;
  lastBilledAt: string;
  costUsd: string;
  ledgerId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

let sessions: InMemorySession[] = [];
let insertedComputeSessionData: Record<string, unknown> | null = null;
let debitCalls: { accountId: string; amount: number; description: string; ledgerType: string }[] = [];
let simulateUniqueViolationOnInsert = false;
let holdFirstDebit = false;
let releaseFirstDebit: (() => void) | null = null;
let firstDebitStarted: Promise<void> = Promise.resolve();
let signalFirstDebitStarted: (() => void) | null = null;

mock.module('../../billing/repositories/compute-sessions', () => ({
  insertComputeSession: async (data: any) => {
    insertedComputeSessionData = data;
    if (simulateUniqueViolationOnInsert) {
      simulateUniqueViolationOnInsert = false;
      const err = new Error('duplicate open compute session') as Error & { code?: string };
      err.code = '23505';
      throw err;
    }
    const row: InMemorySession = {
      id: `cs_${sessions.length + 1}`,
      accountId: data.accountId,
      sandboxId: data.sandboxId,
      sessionId: data.sessionId ?? null,
      actorUserId: data.actorUserId ?? null,
      provider: data.provider ?? 'daytona',
      cpuCores: data.cpuCores,
      memoryGb: data.memoryGb,
      diskGb: data.diskGb,
      gpuCount: data.gpuCount ?? 0,
      state: data.state ?? 'active',
      startedAt: data.startedAt ?? new Date().toISOString(),
      endedAt: null,
      lastBilledAt: data.lastBilledAt ?? new Date().toISOString(),
      costUsd: '0',
      ledgerId: null,
      metadata: data.metadata ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.push(row);
    return row;
  },
  getOpenComputeSession: async (sandboxId: string) =>
    sessions.find((s) => s.sandboxId === sandboxId && s.endedAt === null) ?? null,
  getLatestComputeSession: async (sandboxId: string) =>
    sessions
      .filter((s) => s.sandboxId === sandboxId)
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )[0] ?? null,
  // The claim/release pair the real repository uses. Implemented FAITHFULLY
  // rather than stubbed true: the compare-and-set IS the fix (one settler wins a
  // window, the loser bills nothing), so a fake that always succeeded would let
  // the double-billing regression back in with the suite still green.
  claimComputeWindow: async (input: {
    id: string;
    expectedLastBilledAt: string;
    nextLastBilledAt: string;
    addCostUsd: number;
    terminalState?: 'stopped' | 'finalized';
  }) => {
    const row = sessions.find((r: any) => r.id === input.id);
    if (!row) return false;
    if (row.endedAt !== null && row.endedAt !== undefined) return false;
    if (row.lastBilledAt !== input.expectedLastBilledAt) return false;
    row.lastBilledAt = input.nextLastBilledAt;
    row.costUsd = String(Number(row.costUsd ?? 0) + input.addCostUsd);
    if (input.terminalState) {
      row.state = input.terminalState;
      row.endedAt = input.nextLastBilledAt;
    }
    return true;
  },
  releaseComputeWindow: async (input: {
    id: string;
    claimedLastBilledAt: string;
    revertToLastBilledAt: string;
    subCostUsd: number;
    terminalState?: 'stopped' | 'finalized';
  }) => {
    const row = sessions.find((r: any) => r.id === input.id);
    if (!row) return false;
    if (row.lastBilledAt !== input.claimedLastBilledAt) return false;
    row.lastBilledAt = input.revertToLastBilledAt;
    row.costUsd = String(Number(row.costUsd ?? 0) - input.subCostUsd);
    if (input.terminalState) {
      row.state = 'active';
      row.endedAt = null;
    }
    return true;
  },
  findStaleActiveSessions: async (cutoff: Date) =>
    sessions.filter(
      (s) => s.state === 'active' && new Date(s.lastBilledAt) <= cutoff,
    ),
  getComputeUsageSince: async () => ({ totalCostUsd: 0, sessionCount: 0 }),
}));

// Override the credits mock to actually capture the type tag.
mock.module('../../billing/services/credits', () => ({
  calculateTokenCost: () => 0,
  getBalance: async () => ({ balance: 0, expiring: 0, nonExpiring: 0, daily: 0 }),
  getCreditSummary: async () => ({ total: 0, daily: 0, monthly: 0, extra: 0, canRun: true }),
  deductCredits: async (accountId: string, amount: number, description: string, ledgerType = 'usage') => {
    debitCalls.push({ accountId, amount, description, ledgerType });
    if (holdFirstDebit && debitCalls.length === 1) {
      signalFirstDebitStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirstDebit = resolve;
      });
    }
    return { success: true, cost: amount, newBalance: 0, transactionId: 'tx_test' };
  },
  deductForLlmUsage: async () => ({ success: true, cost: 0, newBalance: 0, transactionId: null }),
  refreshDailyCredits: async () => null,
  grantCredits: async () => undefined,
  resetExpiringCredits: async () => undefined,
}));

const {
  startComputeSession,
  pauseComputeSession,
  resumeComputeSession,
  endComputeSession,
  tickRunningComputeCharges,
  calculateComputeCost,
} = await import('../../billing/services/compute-metering');

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

beforeEach(() => {
  sessions = [];
  insertedComputeSessionData = null;
  debitCalls = [];
  simulateUniqueViolationOnInsert = false;
  holdFirstDebit = false;
  releaseFirstDebit = null;
  firstDebitStarted = new Promise<void>((resolve) => {
    signalFirstDebitStarted = resolve;
  });
  resetMockRegistry();
  // Default to a per-seat account so metering engages.
  mockRegistry.getCreditAccount = async () =>
    createMockCreditAccount({ billingModel: 'per_seat', balance: '100.0000' });
});

describe('compute metering — per-seat happy path', () => {
  test('start opens a session row and does not debit', async () => {
    const id = await startComputeSession({
      sandboxId: 'sb_1',
      accountId: 'acc_test_123',
      sessionId: 'sb_1',
      actorUserId: 'usr_1',
      spec: SPEC,
    });

    expect(id).not.toBeNull();
    expect(sessions.length).toBe(1);
    expect(sessions[0].state).toBe('active');
    expect(sessions[0].endedAt).toBeNull();
    expect(debitCalls.length).toBe(0);
  });

  test('start pins the initial billing cursor to the stored start timestamp', async () => {
    await startComputeSession({
      sandboxId: 'sb_timestamp_precision',
      accountId: 'acc_test_123',
      spec: SPEC,
    });

    expect(typeof insertedComputeSessionData?.startedAt).toBe('string');
    expect(insertedComputeSessionData?.lastBilledAt).toBe(insertedComputeSessionData?.startedAt);
  });

  test('pause finalizes the row, debits with compute_debit type, and matches cost formula', async () => {
    await startComputeSession({
      sandboxId: 'sb_1',
      accountId: 'acc_test_123',
      spec: SPEC,
    });

    // Backdate started_at by exactly 300s so the cost is deterministic.
    const STARTED_BACK_SECONDS = 300;
    sessions[0].lastBilledAt = new Date(Date.now() - STARTED_BACK_SECONDS * 1000).toISOString();

    await pauseComputeSession('sb_1');

    expect(debitCalls.length).toBe(1);
    expect(debitCalls[0].ledgerType).toBe('compute_debit');

    // Cost should match the formula within a tiny tolerance (a few ms drift).
    const expected = calculateComputeCost(SPEC, STARTED_BACK_SECONDS);
    expect(Math.abs(debitCalls[0].amount - expected)).toBeLessThan(expected * 0.01);

    expect(sessions[0].state).toBe('stopped');
    expect(sessions[0].endedAt).not.toBeNull();
  });

  test('concurrent closes use one terminal cutoff and cannot bill past ended_at', async () => {
    await startComputeSession({
      sandboxId: 'sb_close_race',
      accountId: 'acc_test_123',
      spec: SPEC,
    });

    const initialCursor = new Date(Date.now() - 5_000);
    const firstCutoff = new Date(initialCursor.getTime() + 1_000);
    const secondCutoff = new Date(initialCursor.getTime() + 2_000);
    sessions[0].lastBilledAt = initialCursor.toISOString();
    holdFirstDebit = true;

    const firstClose = pauseComputeSession('sb_close_race', firstCutoff);
    await firstDebitStarted;

    // The first debit is deliberately held between the cursor claim and the
    // old non-atomic ended_at write. A second closer can otherwise claim the
    // next 1s window and close later before the first caller writes backwards.
    await pauseComputeSession('sb_close_race', secondCutoff);
    releaseFirstDebit?.();
    await firstClose;

    expect(debitCalls).toHaveLength(1);
    expect(sessions[0].state).toBe('stopped');
    expect(sessions[0].lastBilledAt).toBe(firstCutoff.toISOString());
    expect(sessions[0].endedAt).toBe(firstCutoff.toISOString());
  });

  test('resume opens a brand new row, old row stays closed', async () => {
    await startComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
    await pauseComputeSession('sb_1');
    expect(sessions.length).toBe(1);

    await resumeComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
    expect(sessions.length).toBe(2);
    expect(sessions[0].state).toBe('stopped');
    expect(sessions[1].state).toBe('active');
    expect(sessions[1].endedAt).toBeNull();
  });

  test('end finalizes the open row', async () => {
    await startComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
    sessions[0].lastBilledAt = new Date(Date.now() - 60 * 1000).toISOString();

    await endComputeSession('sb_1');

    expect(sessions[0].state).toBe('finalized');
    expect(sessions[0].endedAt).not.toBeNull();
    expect(debitCalls.length).toBe(1);
    expect(debitCalls[0].ledgerType).toBe('compute_debit');
  });

  test('cron tick partial-bills long-running active sessions without closing them', async () => {
    await startComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
    // Make the session look 2h old at last_billed_at.
    sessions[0].lastBilledAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const result = await tickRunningComputeCharges();

    expect(result.settled).toBe(1);
    expect(debitCalls.length).toBe(1);
    expect(debitCalls[0].ledgerType).toBe('compute_debit');
    // Row should still be active and open (tick is partial billing).
    expect(sessions[0].state).toBe('active');
    expect(sessions[0].endedAt).toBeNull();
  });

  test('start is idempotent — second call returns existing row id', async () => {
    const first = await startComputeSession({
      sandboxId: 'sb_1',
      accountId: 'acc_test_123',
      spec: SPEC,
    });
    const second = await startComputeSession({
      sandboxId: 'sb_1',
      accountId: 'acc_test_123',
      spec: SPEC,
    });
    expect(first).toBe(second);
    expect(sessions.length).toBe(1);
  });

  test('start recovers from database unique-open-session races by returning the winning row', async () => {
    const winner: InMemorySession = {
      id: 'cs_winner',
      accountId: 'acc_test_123',
      sandboxId: 'sb_race',
      sessionId: null,
      actorUserId: null,
      provider: 'daytona',
      cpuCores: SPEC.cpuCores,
      memoryGb: SPEC.memoryGb,
      diskGb: SPEC.diskGb,
      gpuCount: SPEC.gpuCount,
      state: 'active',
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastBilledAt: new Date().toISOString(),
      costUsd: '0',
      ledgerId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    simulateUniqueViolationOnInsert = true;
    queueMicrotask(() => sessions.push(winner));

    const id = await startComputeSession({
      sandboxId: 'sb_race',
      accountId: 'acc_test_123',
      spec: SPEC,
    });

    expect(id).toBe('cs_winner');
    expect(sessions.filter((s) => s.sandboxId === 'sb_race')).toHaveLength(1);
  });

  test('pause is a safe no-op when no open session exists', async () => {
    await pauseComputeSession('sb_does_not_exist');
    expect(debitCalls.length).toBe(0);
    expect(sessions.length).toBe(0);
  });
});

describe('compute metering — legacy guard', () => {
  test('legacy account: start is a no-op, no session row, no debit', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'legacy' });

    const id = await startComputeSession({
      sandboxId: 'sb_legacy',
      accountId: 'acc_legacy',
      spec: SPEC,
    });

    expect(id).toBeNull();
    expect(sessions.length).toBe(0);
    expect(debitCalls.length).toBe(0);
  });

  test('legacy account: pause is also a no-op (nothing to close)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({ billingModel: 'legacy' });

    await pauseComputeSession('sb_legacy');
    expect(debitCalls.length).toBe(0);
  });
});

describe('compute metering — cost calculation', () => {
  test('zero duration → zero cost', () => {
    expect(calculateComputeCost(SPEC, 0)).toBe(0);
  });

  test('hourly cost is $0.201312 for a 2/4/20 sandbox', () => {
    const c = calculateComputeCost(SPEC, 3600);
    expect(c).toBeCloseTo(0.201312, 8);
  });

  test('provider attribution is persisted and hosted providers use one customer rate', async () => {
    await startComputeSession({
      sandboxId: 'sb_e2b',
      accountId: 'acc_test_123',
      provider: 'e2b',
      spec: SPEC,
    });

    expect(sessions[0].provider).toBe('e2b');
    expect(calculateComputeCost(SPEC, 3600, 'e2b')).toBeCloseTo(
      calculateComputeCost(SPEC, 3600, 'daytona'),
      8,
    );
    expect(calculateComputeCost(SPEC, 3600, 'platinum')).toBeCloseTo(
      calculateComputeCost(SPEC, 3600, 'daytona'),
      8,
    );
  });
});
