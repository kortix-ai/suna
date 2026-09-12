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

const ATTACHMENT_RENAME = {
  legacyName: '20260908152048390_prompt_attachments',
  currentName: '20260912000000000_prompt_attachments',
  filename: '20260912000000000_prompt_attachments.sql',
  sha256: '3c08fbc32f525724209beab90e260683bc1e04def056b10a3cc5163cebb48eb4',
} as const;

const ATTACHMENT_PREREQUISITES = [
  {
    name: '20260909083000000_drop_dead_audit_events_index.concurrent',
    filename: '20260909083000000_drop_dead_audit_events_index.concurrent.ts',
    sha256: 'd2167dfe3ce1403eb25adc470a47394d88782f1565ce1262cef32eaa3ec280a2',
  },
  {
    name: '20260910164412042_drop_dead_audit_events_index_snapshot',
    filename: '20260910164412042_drop_dead_audit_events_index_snapshot.sql',
    sha256: '4eda6197b04bea9651f3c734d44281947b9095cd04c08ef02b8aba8284717ce4',
  },
] as const;

const MIGRATION_RENAMES = [
  ...SANDBOX_DEADLINE_RENAMES,
  ...APP_ACCESS_RENAMES,
  ATTACHMENT_RENAME,
] as const;

const REPAIR_NAMES = [
  CONNECTOR_POLICY_MIGRATION.name,
  ...ATTACHMENT_PREREQUISITES.map(({ name }) => name),
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
  attachmentRepair?: { runOn: Date; missingPrerequisites: string[] };
}

export function planMigrationLedgerRepair(
  rows: MigrationLedgerRow[],
): MigrationLedgerRepairPlan | null {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const attachment = byName.get(ATTACHMENT_RENAME.legacyName);
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
    ...(attachment
      ? {
          attachmentRepair: {
            runOn: attachment.runOn,
            missingPrerequisites: ATTACHMENT_PREREQUISITES.filter(
              ({ name }) => !byName.has(name),
            ).map(({ name }) => name),
          },
        }
      : {}),
  };
}

function verifyRepairArtifacts(migrationsDir: string): void {
  const artifacts = [CONNECTOR_POLICY_MIGRATION, ...MIGRATION_RENAMES, ...ATTACHMENT_PREREQUISITES];
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
    if (plan.attachmentRepair?.missingPrerequisites.length) {
      throw new Error(
        'Migration ledger repair requires both attachment prerequisites to be applied first.',
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

    if (plan.attachmentRepair) {
      // Preserve actual prerequisite timestamps. Earlier migrations can share
      // the attachment's transaction timestamp, so backdating is not safe.
      const result = await client.query(
        `update kortix_migrations.pgmigrations
            set run_on = greatest(run_on, (
              select max(run_on) from kortix_migrations.pgmigrations where name = any($2::text[])
            )) + interval '1 millisecond'
          where name = $1`,
        [ATTACHMENT_RENAME.currentName, ATTACHMENT_PREREQUISITES.map(({ name }) => name)],
      );
      if (result.rowCount !== 1)
        throw new Error('Could not order the repaired attachment migration.');
    }

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
  applyAttachmentPrerequisite?: (name: string) => Promise<void>;
}): Promise<boolean> {
  const initialPlan = await inspectRepairPlan(options.databaseUrl);
  if (!initialPlan) return false;

  verifyRepairArtifacts(options.migrationsDir);
  if (initialPlan.connectorMigrationIsMissing) {
    await options.applyConnectorMigration();
  }
  for (const name of initialPlan.attachmentRepair?.missingPrerequisites ?? []) {
    if (!options.applyAttachmentPrerequisite)
      throw new Error('Attachment prerequisite runner is required.');
    await options.applyAttachmentPrerequisite(name);
  }

  return reconcileRepairPlan(options.databaseUrl);
}

export const migrationLedgerRepairConnectorName = CONNECTOR_POLICY_MIGRATION.name;
