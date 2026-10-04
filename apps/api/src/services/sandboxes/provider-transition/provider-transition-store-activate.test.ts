/**
 * Characterization tests for `activateWithCas` (KRTX-315): they pin the five
 * result branches, the write ordering inside the transaction, and the
 * after-commit audit dispatch so the extraction of the transaction body stays
 * behavior-preserving. A mocked `db` cannot prove the SQL WHERE predicates —
 * those stay proven by `provider-transition-flow.integration.test.ts` against
 * real PostgreSQL; here only ordering and branching are asserted.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { type Database, projects, providerTransitions } from '@kortix/db';
import * as realAudit from './provider-transition-audit';

// mock.module replaces the audit module WHOLESALE for importers, so spread the
// real module and override only the hook the store calls.
const auditCalls: Array<{ row: unknown; result: unknown }> = [];
mock.module('./provider-transition-audit', () => ({
  ...realAudit,
  auditProviderTransition: async (row: unknown, result: unknown) => {
    auditCalls.push({ row, result });
  },
}));

// Imported AFTER mock.module so the store binds the audit spy, not the real hook.
const { activateWithCas } = await import('./provider-transition-store');

const NOW = new Date('2026-09-29T00:00:00.000Z');

type CapturedWrite = { table: unknown; set: Record<string, unknown> };

/** A `Database` whose `transaction` runs the callback against a fake `tx` that
 *  answers the two selects (project lock, lease epoch) and records every
 *  update's `set` payload in call order. */
function activateDatabase(state: {
  project: Record<string, unknown> | null;
  leaseEpoch: number | null;
  auditRow: Record<string, unknown> | null;
  writes: CapturedWrite[];
}): Database {
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          // The project lock chains .for('update').limit(1).
          for: () => ({ limit: async () => (state.project ? [state.project] : []) }),
          // The lease fence chains .limit(1) directly on the transition table.
          limit: async () =>
            table === providerTransitions && state.leaseEpoch !== null
              ? [{ leaseEpoch: state.leaseEpoch }]
              : [],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        state.writes.push({ table, set: values });
        return {
          where: () => ({
            returning: async () => (state.auditRow ? [state.auditRow] : []),
          }),
        };
      },
    }),
  };
  return {
    transaction: (cb: (tx: unknown) => unknown) => cb(tx),
  } as unknown as Database;
}

function activateArgs(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    transitionId: 'transition-1',
    targetProvider: 'platinum',
    generation: 3,
    snapshotName: 'kortix-ppwarm-project-1',
    externalTemplateId: 'tpl-1',
    now: NOW,
    ...overrides,
  };
}

function activateState(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      metadata: {},
      generation: 3,
      status: 'active',
      ...overrides,
    } as Record<string, unknown> | null,
    leaseEpoch: null as number | null,
    auditRow: null as Record<string, unknown> | null,
    writes: [] as CapturedWrite[],
  };
}

describe('activateWithCas (characterization)', () => {
  beforeEach(() => {
    auditCalls.length = 0;
  });

  test('a winning activation writes the pin, activates the row, then supersedes lower generations', async () => {
    const state = activateState({
      generation: 3,
    });
    state.auditRow = {
      transitionId: 'transition-1',
      accountId: 'account-1',
      projectId: 'project-1',
      sourceProvider: 'daytona',
      targetProvider: 'platinum',
      mode: 'switch',
      generation: 3,
    };
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs());

    expect(result).toEqual({ activated: true, reason: 'won' });
    expect(state.writes).toHaveLength(3);
    const [pinWrite, activateWrite, supersedeWrite] = state.writes;
    // 1. The pin write targets the project row with the metadata merge + updatedAt.
    expect(pinWrite?.table).toBe(projects);
    expect(pinWrite?.set.updatedAt).toBe(NOW);
    expect('metadata' in (pinWrite?.set ?? {})).toBe(true);
    // 2. The activation write flips the transition row to `activated` and clears
    //    the lease bookkeeping.
    expect(activateWrite?.table).toBe(providerTransitions);
    expect(activateWrite?.set.status).toBe('activated');
    expect(activateWrite?.set.activatedAt).toBe(NOW);
    expect(activateWrite?.set.heartbeatAt).toBeNull();
    expect(activateWrite?.set.lastError).toBeNull();
    expect(activateWrite?.set.errorClass).toBeNull();
    expect(activateWrite?.set.nextRetryAt).toBeNull();
    // 3. Lower live generations are superseded only after the activation write.
    expect(supersedeWrite?.table).toBe(providerTransitions);
    expect(supersedeWrite?.set.status).toBe('superseded');
    expect(supersedeWrite?.set.heartbeatAt).toBeNull();
    // The outcome audit dispatches after COMMIT, once, for the activated row.
    expect(auditCalls).toHaveLength(1);
    const [auditCall] = auditCalls;
    expect(auditCall?.result).toEqual({ outcome: 'activated' });
    expect((auditCall?.row as { transitionId: string } | undefined)?.transitionId).toBe(
      'transition-1',
    );
  });

  test('a matching lease epoch does not fence activation out', async () => {
    const state = activateState({ generation: 3 });
    state.leaseEpoch = 2;
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs({ leaseEpoch: 2 }));

    expect(result).toEqual({ activated: true, reason: 'won' });
    expect(state.writes).toHaveLength(3);
    expect(auditCalls).toHaveLength(0);
  });

  test('a mismatched lease epoch loses the lease without touching the pin or the row', async () => {
    const state = activateState({ generation: 3 });
    state.leaseEpoch = 3;
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs({ leaseEpoch: 2 }));

    expect(result).toEqual({ activated: false, reason: 'lost_lease' });
    expect(state.writes).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test('a lost generation CAS supersedes only the transition row, never the pin', async () => {
    const state = activateState({ generation: 5 });
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs({ generation: 3 }));

    expect(result).toEqual({ activated: false, reason: 'lost_cas' });
    expect(state.writes).toHaveLength(1);
    const [supersedeWrite] = state.writes;
    expect(supersedeWrite?.table).toBe(providerTransitions);
    expect(supersedeWrite?.set.status).toBe('superseded');
    expect(supersedeWrite?.set.heartbeatAt).toBeNull();
    expect(supersedeWrite?.set.updatedAt).toBe(NOW);
    expect(auditCalls).toHaveLength(0);
  });

  test('a missing project row returns project_missing without any write', async () => {
    const state = activateState();
    state.project = null;
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs());

    expect(result).toEqual({ activated: false, reason: 'project_missing' });
    expect(state.writes).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test('an archived project returns project_archived without any write', async () => {
    const state = activateState({ status: 'archived' });
    const db = activateDatabase(state);

    const result = await activateWithCas(db, activateArgs());

    expect(result).toEqual({ activated: false, reason: 'project_archived' });
    expect(state.writes).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
