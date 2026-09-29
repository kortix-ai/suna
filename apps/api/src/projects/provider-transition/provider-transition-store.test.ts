import { describe, expect, mock, test } from 'bun:test';
import { type Database, projects } from '@kortix/db';
import {
  ACTIVE_EXTERNAL_ID_META_KEY,
  ACTIVE_SNAPSHOT_NAME_META_KEY,
  PIN_META_KEY,
  TRANSITION_META_KEY,
  activateWithCas,
  readActiveRouting,
} from './provider-transition-store';

function databaseReturning(
  row: {
    metadata: Record<string, unknown> | null;
    generation: number | null;
  } | null,
): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

describe('readActiveRouting', () => {
  test('reads the activated image name with its provider and external id', async () => {
    const routing = await readActiveRouting(
      databaseReturning({
        metadata: {
          [PIN_META_KEY]: 'platinum',
          [ACTIVE_EXTERNAL_ID_META_KEY]: 'tpl_project_current',
          [ACTIVE_SNAPSHOT_NAME_META_KEY]: 'kortix-ppwarm-project-current',
        },
        generation: 7,
      }),
      'project-1',
    );

    expect(routing).toEqual({
      activeProvider: 'platinum',
      activeExternalTemplateId: 'tpl_project_current',
      activeSnapshotName: 'kortix-ppwarm-project-current',
      generation: 7,
    });
  });

  test('returns null image metadata for a legacy activation record', async () => {
    const routing = await readActiveRouting(
      databaseReturning({
        metadata: {
          [PIN_META_KEY]: 'platinum',
          [ACTIVE_EXTERNAL_ID_META_KEY]: 'tpl_legacy',
        },
        generation: null,
      }),
      'project-1',
    );

    expect(routing).toEqual({
      activeProvider: 'platinum',
      activeExternalTemplateId: 'tpl_legacy',
      activeSnapshotName: null,
      generation: 0,
    });
  });

  test('recovers an exact activated image name from a legacy transition marker', async () => {
    const routing = await readActiveRouting(
      databaseReturning({
        metadata: {
          [PIN_META_KEY]: 'platinum',
          [ACTIVE_EXTERNAL_ID_META_KEY]: 'tpl_legacy',
          [TRANSITION_META_KEY]: {
            status: 'activated',
            target_provider: 'platinum',
            external_template_id: 'tpl_legacy',
            snapshot_name: 'kortix-ppwarm-project-legacy',
            generation: 4,
          },
        },
        generation: 4,
      }),
      'project-1',
    );

    expect(routing).toEqual({
      activeProvider: 'platinum',
      activeExternalTemplateId: 'tpl_legacy',
      activeSnapshotName: 'kortix-ppwarm-project-legacy',
      generation: 4,
    });
  });

  test.each([
    { label: 'status', patch: { status: 'building' } },
    { label: 'provider', patch: { target_provider: 'daytona' } },
    { label: 'external id', patch: { external_template_id: 'tpl_other' } },
    { label: 'generation', patch: { generation: 3 } },
    { label: 'snapshot name', patch: { snapshot_name: '' } },
  ])('rejects legacy image metadata with a mismatched $label', async ({ patch }) => {
    const routing = await readActiveRouting(
      databaseReturning({
        metadata: {
          [PIN_META_KEY]: 'platinum',
          [ACTIVE_EXTERNAL_ID_META_KEY]: 'tpl_legacy',
          [TRANSITION_META_KEY]: {
            status: 'activated',
            target_provider: 'platinum',
            external_template_id: 'tpl_legacy',
            snapshot_name: 'kortix-ppwarm-project-legacy',
            generation: 4,
            ...patch,
          },
        },
        generation: 4,
      }),
      'project-1',
    );

    expect(routing?.activeSnapshotName).toBeNull();
  });
});

// ─── activateWithCas (characterization) ──────────────────────────────────────
// Pins the activation CAS branches and the write ORDER so the transaction body
// can be extracted behavior-preserving: the five reason variants, the
// pin→activate→supersede sequencing, and the post-commit audit row. The SQL
// guards themselves are proven by provider-transition-flow.integration.test.ts
// (Docker-backed).

mock.module('./provider-transition-audit', () => ({
  auditProviderTransition: async (row: unknown, result: unknown) => {
    auditCalls.push({ row, result });
  },
}));

const auditCalls: Array<{ row: unknown; result: unknown }> = [];

const CAS_ARGS = {
  projectId: '00000000-0000-4000-a000-000000000201',
  transitionId: '00000000-0000-4000-a000-000000000501',
  targetProvider: 'platinum',
  generation: 3,
  snapshotName: 'kortix-ppwarm-project-current',
  externalTemplateId: 'tpl_project_current',
  now: new Date('2026-01-01T00:00:00Z'),
};

const AUDIT_ROW = {
  transitionId: CAS_ARGS.transitionId,
  accountId: '00000000-0000-4000-a000-000000000101',
  projectId: CAS_ARGS.projectId,
  sourceProvider: 'daytona',
  targetProvider: 'platinum',
  mode: 'switch',
  generation: 3,
};

/** A transaction harness that scripts the locked project row + the row's lease
 *  epoch and records every write in order, so branch + ordering behavior is
 *  pinned without a database. */
function activateHarness(script: {
  project: { metadata: unknown; generation: number | null; status: string } | null;
  leaseEpoch: number | null;
}) {
  const writes: Array<{ table: 'projects' | 'transitions'; status: unknown }> = [];
  auditCalls.length = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => (script.project ? [script.project] : []) }),
          limit: async () => [{ leaseEpoch: script.leaseEpoch }],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const record = () =>
            writes.push({
              table: table === projects ? 'projects' : 'transitions',
              status: patch.status,
            });
          // A waitable handle: the store awaits update chains directly, except
          // the activation write, which reads its row back through `.returning()`.
          return {
            returning: async () => {
              record();
              return [AUDIT_ROW];
            },
            // biome-ignore lint/suspicious/noThenProperty: the fake where-result must be awaitable without `.returning()`
            then: (resolve: (v?: unknown) => void) => {
              record();
              resolve();
            },
          };
        },
      }),
    }),
  } as unknown as Parameters<Parameters<Database['transaction']>[0]>[0];
  const db = {
    transaction: (cb: (tx: unknown) => unknown) => Promise.resolve(cb(tx)),
  } as unknown as Database;
  return { db, writes };
}

describe('activateWithCas', () => {
  test('project missing → refused without a write', async () => {
    const h = activateHarness({ project: null, leaseEpoch: null });
    expect(await activateWithCas(h.db, { ...CAS_ARGS })).toEqual({
      activated: false,
      reason: 'project_missing',
    });
    expect(h.writes).toEqual([]);
  });

  test('archived project → refused without a write', async () => {
    const h = activateHarness({
      project: { metadata: {}, generation: 3, status: 'archived' },
      leaseEpoch: null,
    });
    expect(await activateWithCas(h.db, { ...CAS_ARGS })).toEqual({
      activated: false,
      reason: 'project_archived',
    });
    expect(h.writes).toEqual([]);
  });

  test('lost lease → refused without a write (pin untouched, row not superseded)', async () => {
    const h = activateHarness({
      project: { metadata: {}, generation: 3, status: 'active' },
      leaseEpoch: 2,
    });
    expect(await activateWithCas(h.db, { ...CAS_ARGS, leaseEpoch: 3 })).toEqual({
      activated: false,
      reason: 'lost_lease',
    });
    expect(h.writes).toEqual([]);
  });

  test('lost CAS → the row is superseded and the pin stays untouched', async () => {
    const h = activateHarness({
      project: { metadata: {}, generation: 4, status: 'active' },
      leaseEpoch: null,
    });
    expect(await activateWithCas(h.db, { ...CAS_ARGS })).toEqual({
      activated: false,
      reason: 'lost_cas',
    });
    expect(h.writes).toEqual([{ table: 'transitions', status: 'superseded' }]);
  });

  test('won → pin merge, activation, then lower live rows superseded; audits the row after commit', async () => {
    const h = activateHarness({
      project: { metadata: {}, generation: 3, status: 'active' },
      leaseEpoch: 3,
    });
    expect(await activateWithCas(h.db, { ...CAS_ARGS, leaseEpoch: 3 })).toEqual({
      activated: true,
      reason: 'won',
    });
    expect(h.writes).toEqual([
      { table: 'projects', status: undefined }, // the pin merge carries no status
      { table: 'transitions', status: 'activated' },
      { table: 'transitions', status: 'superseded' },
    ]);
    expect(auditCalls).toEqual([{ row: AUDIT_ROW, result: { outcome: 'activated' } }]);
  });
});
