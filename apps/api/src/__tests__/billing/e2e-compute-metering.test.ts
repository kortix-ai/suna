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
import {
  COMPUTE_CPU_PRICE_PER_CORE_SECOND,
  COMPUTE_DISK_PRICE_PER_GB_SECOND,
  COMPUTE_MEMORY_PRICE_PER_GB_SECOND,
  COMPUTE_PRICE_MARKUP,
} from '../../billing/services/tiers';

registerGlobalMocks();
registerCreditsMock();

// ─── Mock the compute-sessions + yolo repos used by compute-metering ─────────

interface InMemorySession {
  id: string;
  accountId: string;
  sandboxId: string;
  sessionId: string | null;
  actorUserId: string | null;
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
let debitCalls: { accountId: string; amount: number; description: string; ledgerType: string }[] = [];

mock.module('../../billing/repositories/compute-sessions', () => ({
  insertComputeSession: async (data: any) => {
    const row: InMemorySession = {
      id: `cs_${sessions.length + 1}`,
      accountId: data.accountId,
      sandboxId: data.sandboxId,
      sessionId: data.sessionId ?? null,
      actorUserId: data.actorUserId ?? null,
      cpuCores: data.cpuCores,
      memoryGb: data.memoryGb,
      diskGb: data.diskGb,
      gpuCount: data.gpuCount ?? 0,
      state: data.state ?? 'active',
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastBilledAt: new Date().toISOString(),
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
  updateComputeSession: async (id: string, patch: any) => {
    const row = sessions.find((s) => s.id === id);
    if (!row) return;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  },
  findStaleActiveSessions: async (cutoff: Date) =>
    sessions.filter(
      (s) => s.state === 'active' && new Date(s.lastBilledAt) <= cutoff,
    ),
}));

// Override the credits mock to actually capture the type tag.
mock.module('../../billing/services/credits', () => ({
  calculateTokenCost: () => 0,
  getCreditSummary: async () => ({ total: 0, daily: 0, monthly: 0, extra: 0, canRun: true }),
  deductCredits: async (accountId: string, amount: number, description: string, ledgerType = 'usage') => {
    debitCalls.push({ accountId, amount, description, ledgerType });
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
  endComputeSession,
  tickRunningComputeCharges,
} = await import('../../billing/services/compute-metering');

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

function expectedComputeCost(spec: typeof SPEC, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return (
    spec.cpuCores * COMPUTE_CPU_PRICE_PER_CORE_SECOND * durationSeconds +
    spec.memoryGb * COMPUTE_MEMORY_PRICE_PER_GB_SECOND * durationSeconds +
    spec.diskGb * COMPUTE_DISK_PRICE_PER_GB_SECOND * durationSeconds
  ) * COMPUTE_PRICE_MARKUP;
}

beforeEach(() => {
  sessions = [];
  debitCalls = [];
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
    const expected = expectedComputeCost(SPEC, STARTED_BACK_SECONDS);
    expect(Math.abs(debitCalls[0].amount - expected)).toBeLessThan(expected * 0.01);

    expect(sessions[0].state).toBe('stopped');
    expect(sessions[0].endedAt).not.toBeNull();
  });

  test('starting after pause opens a brand new row, old row stays closed', async () => {
    await startComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
    await pauseComputeSession('sb_1');
    expect(sessions.length).toBe(1);

    await startComputeSession({ sandboxId: 'sb_1', accountId: 'acc_test_123', spec: SPEC });
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
    expect(expectedComputeCost(SPEC, 0)).toBe(0);
  });

  test('hourly cost is in the expected range for a 2/4/20 sandbox', () => {
    const c = expectedComputeCost(SPEC, 3600);
    expect(c).toBeGreaterThan(0.10);
    expect(c).toBeLessThan(0.15);
  });
});
