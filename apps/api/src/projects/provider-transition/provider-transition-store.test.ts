import { describe, expect, test } from 'bun:test';
import { type Database, projects, providerTransitions } from '@kortix/db';
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

/**
 * Minimal transaction handle for `activateWithCas`. It answers the two SELECTs
 * (project row, then the lease-epoch read) and records every UPDATE. The generated
 * SQL is not asserted here — this pins the DECISION (which reason, which writer
 * ran); the integration flow pins the SQL against real PostgreSQL.
 */
function activationTransaction(opts: {
  project: {
    metadata: Record<string, unknown> | null;
    generation: number | null;
    status: string;
  } | null;
  leaseEpochRow?: { leaseEpoch: number | null } | null;
}) {
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const tx = {
    select(columns: Record<string, unknown>) {
      const readingLeaseEpoch = 'leaseEpoch' in columns;
      return {
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => (opts.project ? [opts.project] : []) }),
            limit: async () => {
              if (readingLeaseEpoch) return opts.leaseEpochRow ? [opts.leaseEpochRow] : [];
              return opts.project ? [opts.project] : [];
            },
          }),
        }),
      };
    },
    update(table: unknown) {
      return {
        set: (set: Record<string, unknown>) => {
          updates.push({ table, set });
          return {
            where: () =>
              Object.assign(Promise.resolve([] as unknown[]), { returning: async () => [] }),
          };
        },
      };
    },
  };
  const db = {
    transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as Database;
  return { db, updates };
}

describe('activateWithCas', () => {
  const ARGS = {
    projectId: '00000000-0000-4000-a000-000000000201',
    transitionId: '00000000-0000-4000-a000-000000000501',
    targetProvider: 'platinum',
    generation: 4,
    snapshotName: 'kortix-ppwarm-project-current',
    externalTemplateId: 'tpl_project_current',
    now: new Date('2026-09-26T00:00:00Z'),
  };

  test('a stale generation loses the CAS, supersedes the row, and never moves the pin', async () => {
    const { db, updates } = activationTransaction({
      project: { metadata: { [PIN_META_KEY]: 'daytona' }, generation: 5, status: 'active' },
    });

    const result = await activateWithCas(db, ARGS);

    expect(result).toEqual({ activated: false, reason: 'lost_cas' });
    expect(updates).toEqual([
      {
        table: providerTransitions,
        set: { status: 'superseded', heartbeatAt: null, updatedAt: ARGS.now },
      },
    ]);
  });

  test('a fenced-out zombie loses the lease and touches neither the pin nor the row', async () => {
    const { db, updates } = activationTransaction({
      project: { metadata: { [PIN_META_KEY]: 'daytona' }, generation: 4, status: 'active' },
      leaseEpochRow: { leaseEpoch: 1 },
    });

    const result = await activateWithCas(db, { ...ARGS, leaseEpoch: 2 });

    expect(result).toEqual({ activated: false, reason: 'lost_lease' });
    expect(updates).toEqual([]);
  });
});
