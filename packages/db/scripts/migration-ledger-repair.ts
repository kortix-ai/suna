import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const CONNECTOR_POLICY_MIGRATION = {
  // Historical migration identity. The cutover migration runs later and must
  // never rewrite this filename or its ledger row.
  name: '20260729215216867_executor_policy_arg_conditions',
  filename: '20260729215216867_executor_policy_arg_conditions.sql',
  sha256: 'd2e803a5957df0740fb348f93bab2b5f06609ed2f1c1b9cf8592c634d68066e4',
} as const;

const SANDBOX_DEADLINE_RENAMES = [
  {
    legacyName: '20260729181733802_sandbox_deadline',
    currentName: '20260730000452547_sandbox_deadline',
    filename: '20260730000452547_sandbox_deadline.sql',
    sha256: '9230a593b5dad5d7e405b0271725f0dfaa09f98f7002a171d8edcdd4d00af392',
  },
  {
    legacyName: '20260729181804675_sandbox_deadline_index.concurrent',
    currentName: '20260730000452600_sandbox_deadline_index.concurrent',
    filename: '20260730000452600_sandbox_deadline_index.concurrent.ts',
    sha256: '3904ab96efd91f084296ee70a409b76407a36bf1a82859018e44496cc694c2b5',
  },
] as const;

const APP_ACCESS_RENAMES = [
  {
    legacyName: '20260807192000000_add_app_access_control',
    currentName: '20260807211250000_add_app_access_control',
    filename: '20260807211250000_add_app_access_control.sql',
    sha256: '1b02daebaac39a3d28875a0eda09e7d6b41ac44467deaca07d0499f170685ba1',
  },
  {
    legacyName: '20260807192000001_validate_app_access_constraints',
    currentName: '20260807211250001_validate_app_access_constraints',
    filename: '20260807211250001_validate_app_access_constraints.sql',
    sha256: 'eea55922e9601402ed621946151a6afc13c3cd0870d4606d9bfa987c8c43c514',
  },
] as const;

const SECRET_CONSUMER_RENAMES = [
  {
    legacyName: '20260805165801277_secret_consumer_boundary',
    currentName: '20260805202913539_secret_consumer_boundary',
    filename: '20260805202913539_secret_consumer_boundary.sql',
    sha256: '9de8e240356235c49d577e219ca83518eceaacfaab16243aa9b6f15847a2e7d1',
  },
] as const;

const PI_RUNTIME_RENAMES = [
  {
    legacyName: '20260828170156721_session_worker_log',
    currentName: '20260902070000000_session_worker_log',
    filename: '20260902070000000_session_worker_log.sql',
    sha256: '0fafe47bb6b45c50ff4f6b56175337623cea81a2f722eec6294fb60cd35e84e5',
  },
  {
    legacyName: '20260829160353474_pi_runtime_artifacts',
    currentName: '20260902070001000_pi_runtime_artifacts',
    filename: '20260902070001000_pi_runtime_artifacts.sql',
    sha256: '87d0bbacf0fa853f80ad506696e3f556d45c3b934c4d25a9a1edf48ad36fd803',
  },
] as const;

const MIGRATION_RENAMES = [
  ...SANDBOX_DEADLINE_RENAMES,
  ...SECRET_CONSUMER_RENAMES,
  ...APP_ACCESS_RENAMES,
  ...PI_RUNTIME_RENAMES,
] as const;

const REPAIR_NAMES = [
  CONNECTOR_POLICY_MIGRATION.name,
  ...MIGRATION_RENAMES.flatMap(({ legacyName, currentName }) => [legacyName, currentName]),
];

export interface MigrationLedgerRow {
  name: string;
  runOn: Date;
}

export interface MigrationLedgerRepairPlan {
  connectorMigrationIsMissing: boolean;
  legacyRunOn: Date | null;
  renames: Array<{ legacyName: string; currentName: string }>;
}

export function planMigrationLedgerRepair(
  rows: MigrationLedgerRow[],
): MigrationLedgerRepairPlan | null {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const renames = MIGRATION_RENAMES.filter(({ legacyName }) => byName.has(legacyName)).map(
    ({ legacyName, currentName }) => ({ legacyName, currentName }),
  );

  if (renames.length === 0) return null;

  for (const rename of MIGRATION_RENAMES) {
    if (byName.has(rename.legacyName) && byName.has(rename.currentName)) {
      throw new Error(
        `Migration ledger contains both ${rename.legacyName} and ${rename.currentName}.`,
      );
    }
  }

  if (
    byName.has(SANDBOX_DEADLINE_RENAMES[1].legacyName) &&
    !byName.has(SANDBOX_DEADLINE_RENAMES[0].legacyName)
  ) {
    throw new Error(
      'Migration ledger contains the legacy deadline index without its table migration.',
    );
  }

  const deadlineRunOns = SANDBOX_DEADLINE_RENAMES.filter(({ legacyName }) => byName.has(legacyName))
    .map(({ legacyName }) => byName.get(legacyName)?.runOn)
    .filter((runOn): runOn is Date => runOn instanceof Date);
  const legacyRunOn =
    deadlineRunOns.length > 0
      ? deadlineRunOns.reduce((earliest, runOn) => (runOn < earliest ? runOn : earliest))
      : null;

  return {
    connectorMigrationIsMissing:
      deadlineRunOns.length > 0 && !byName.has(CONNECTOR_POLICY_MIGRATION.name),
    legacyRunOn,
    renames,
  };
}

function verifyRepairArtifacts(migrationsDir: string): void {
  const artifacts = [CONNECTOR_POLICY_MIGRATION, ...MIGRATION_RENAMES];
  for (const artifact of artifacts) {
    const path = join(migrationsDir, artifact.filename);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== artifact.sha256) {
      throw new Error(
        `Migration ledger repair checksum mismatch for ${artifact.filename}: ${actual}.`,
      );
    }
  }
}

async function readRepairRows(client: pg.Client): Promise<MigrationLedgerRow[]> {
  const tableResult = await client.query<{ exists: boolean }>(
    "select to_regclass('kortix_migrations.pgmigrations') is not null as exists",
  );
  if (!tableResult.rows[0]?.exists) return [];

  const result = await client.query<{ name: string; run_on: Date }>(
    `select name, run_on
       from kortix_migrations.pgmigrations
      where name = any($1::text[])
      order by run_on, id`,
    [REPAIR_NAMES],
  );
  return result.rows.map((row) => ({ name: row.name, runOn: row.run_on }));
}

async function inspectRepairPlan(databaseUrl: string): Promise<MigrationLedgerRepairPlan | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return planMigrationLedgerRepair(await readRepairRows(client));
  } finally {
    await client.end();
  }
}

async function reorderAppliedRenames(
  client: pg.Client,
  renames: MigrationLedgerRepairPlan['renames'],
): Promise<void> {
  const movedNames = renames
    .map(({ currentName }) => currentName)
    .sort();
  if (movedNames.length === 0) return;

  const firstName = movedNames[0];
  const result = await client.query(
    `with boundary as (
       select coalesce(
                max(run_on) filter (where name < $1),
                min(run_on) - interval '1 microsecond',
                timestamp 'epoch'
              ) as anchor
         from kortix_migrations.pgmigrations
     ), ordered as (
       select id, row_number() over (order by name, id) as position
         from kortix_migrations.pgmigrations
        where name >= $1
     ), normalized as (
       select ordered.id,
              boundary.anchor + ordered.position * interval '1 microsecond' as run_on
         from ordered
         cross join boundary
     )
     update kortix_migrations.pgmigrations as ledger
        set run_on = normalized.run_on
       from normalized
      where ledger.id = normalized.id`,
    [firstName],
  );
  if ((result.rowCount ?? 0) < movedNames.length) {
    throw new Error('Migration ledger repair could not reorder the renamed migrations.');
  }
}

async function reconcileRepairPlan(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('lock table kortix_migrations.pgmigrations in exclusive mode');
    const plan = planMigrationLedgerRepair(await readRepairRows(client));
    if (!plan) {
      await client.query('commit');
      return false;
    }
    if (plan.connectorMigrationIsMissing) {
      throw new Error(
        `Migration ledger repair requires ${CONNECTOR_POLICY_MIGRATION.name} to be applied first.`,
      );
    }

    for (const { legacyName, currentName } of plan.renames) {
      const result = await client.query(
        `update kortix_migrations.pgmigrations
            set name = $2
          where name = $1
            and not exists (
              select 1
                from kortix_migrations.pgmigrations
               where name = $2
            )`,
        [legacyName, currentName],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Migration ledger repair could not rename ${legacyName}.`);
      }
    }

    if (plan.legacyRunOn) {
      const orderResult = await client.query(
        `update kortix_migrations.pgmigrations
            set run_on = $2::timestamptz - interval '1 millisecond'
          where name = $1`,
        [CONNECTOR_POLICY_MIGRATION.name, plan.legacyRunOn.toISOString()],
      );
      if (orderResult.rowCount !== 1) {
        throw new Error(
          `Migration ledger repair could not reorder ${CONNECTOR_POLICY_MIGRATION.name}.`,
        );
      }
    }

    await reorderAppliedRenames(client, plan.renames);

    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

export async function repairMigrationLedger(options: {
  databaseUrl: string;
  migrationsDir: string;
  applyConnectorMigration: () => Promise<void>;
}): Promise<boolean> {
  const initialPlan = await inspectRepairPlan(options.databaseUrl);
  if (!initialPlan) return false;

  verifyRepairArtifacts(options.migrationsDir);
  if (initialPlan.connectorMigrationIsMissing) {
    await options.applyConnectorMigration();
  }

  return reconcileRepairPlan(options.databaseUrl);
}

export const migrationLedgerRepairConnectorName = CONNECTOR_POLICY_MIGRATION.name;
