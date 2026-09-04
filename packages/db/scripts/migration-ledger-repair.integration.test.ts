import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import {
  migrationLedgerRepairConnectorName,
  repairMigrationLedger,
} from './migration-ledger-repair';

const adminUrl = process.env.MIGRATION_REPAIR_ADMIN_URL;
const suite = adminUrl ? describe : describe.skip;
const migrationsDir = join(import.meta.dir, '..', 'migrations');
const databaseName = `kortix_migration_repair_${process.pid}_${Date.now()}`;
const piDatabaseName = `kortix_pi_migration_repair_${process.pid}_${Date.now()}`;
const databaseUrl = adminUrl ? new URL(adminUrl) : null;
if (databaseUrl) databaseUrl.pathname = `/${databaseName}`;
const piDatabaseUrl = adminUrl ? new URL(adminUrl) : null;
if (piDatabaseUrl) piDatabaseUrl.pathname = `/${piDatabaseName}`;

let admin: pg.Client;

suite('migration ledger rename repair', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.query(`create database "${piDatabaseName}"`);

    const client = new pg.Client({ connectionString: databaseUrl?.toString() });
    await client.connect();
    try {
      await client.query(`
        create schema kortix;
        create schema kortix_migrations;
        create table kortix.executor_connection_policies (id integer);
        create table kortix.executor_connector_policies (id integer);
        create table kortix.executor_project_policies (id integer);
        create table kortix_migrations.pgmigrations (
          id serial primary key,
          name varchar(255) not null,
          run_on timestamp not null
        );
      `);

      const migrationNames = readdirSync(migrationsDir)
        .filter(
          (filename) =>
            filename.endsWith('.sql') ||
            filename.endsWith('.concurrent.ts') ||
            filename.endsWith('.nontransaction.ts'),
        )
        .sort()
        .map((filename) => filename.replace(/\.sql$/, '').replace(/\.ts$/, ''));
      const connectorIndex = migrationNames.indexOf(migrationLedgerRepairConnectorName);
      expect(connectorIndex).toBeGreaterThan(0);

      const renamedDeadlineNames = new Set([
        '20260730000452547_sandbox_deadline',
        '20260730000452600_sandbox_deadline_index.concurrent',
      ]);
      const appliedNames = migrationNames.filter(
        (name) =>
          name !== migrationLedgerRepairConnectorName &&
          !renamedDeadlineNames.has(name),
      );

      for (const [index, name] of appliedNames.entries()) {
        await client.query(
          `insert into kortix_migrations.pgmigrations (name, run_on)
           values ($1, $2::timestamptz)`,
          [name, new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()],
        );
      }
      await client.query(
        `insert into kortix_migrations.pgmigrations (name, run_on)
         values
           ('20260729181733802_sandbox_deadline', '2026-07-29T16:46:37.325Z'),
           ('20260729181804675_sandbox_deadline_index.concurrent', '2026-07-29T16:46:39.752Z')`,
      );
    } finally {
      await client.end();
    }

    const piClient = new pg.Client({ connectionString: piDatabaseUrl?.toString() });
    await piClient.connect();
    try {
      await piClient.query(`
        create schema kortix_migrations;
        create table kortix_migrations.pgmigrations (
          id serial primary key,
          name varchar(255) not null,
          run_on timestamp not null
        );
      `);

      const currentPiNames = [
        '20260902070000000_session_worker_log',
        '20260902070001000_pi_runtime_artifacts',
      ];
      const currentConsumerBoundaryName = '20260805202913539_secret_consumer_boundary';
      const legacyConsumerBoundaryName = '20260805165801277_secret_consumer_boundary';
      const legacyPiNames = [
        '20260828170156721_session_worker_log',
        '20260829160353474_pi_runtime_artifacts',
      ];
      const migrationNames = readdirSync(migrationsDir)
        .filter(
          (filename) =>
            filename.endsWith('.sql') ||
            filename.endsWith('.concurrent.ts') ||
            filename.endsWith('.nontransaction.ts'),
        )
        .sort()
        .map((filename) => filename.replace(/\.sql$/, '').replace(/\.ts$/, ''));
      const historicalNames = migrationNames
        .filter(
          (name) =>
            !currentPiNames.includes(name) && name !== currentConsumerBoundaryName,
        )
        .concat(legacyConsumerBoundaryName, legacyPiNames)
        .sort();

      for (const name of historicalNames) {
        await piClient.query(
          `insert into kortix_migrations.pgmigrations (name, run_on)
           values ($1, $2::timestamptz)`,
          [name, '2026-09-01T00:00:00.123456Z'],
        );
      }
    } finally {
      await piClient.end();
    }
  });

  afterAll(async () => {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`drop database if exists "${piDatabaseName}" with (force)`);
    await admin.end();
  });

  test('applies the missing migration and restores strict ledger order', async () => {
    const runnerOptions = {
      databaseUrl: databaseUrl?.toString(),
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'kortix_migrations',
      createMigrationsSchema: true,
      singleTransaction: true,
      logger: console,
    } as const;

    const repaired = await repairMigrationLedger({
      databaseUrl: databaseUrl?.toString() ?? '',
      migrationsDir,
      applyConnectorMigration: async () => {
        await runner({
          ...runnerOptions,
          direction: 'up',
          count: 1,
          checkOrder: false,
          file: migrationLedgerRepairConnectorName,
        });
      },
    });

    expect(repaired).toBe(true);
    expect(
      await repairMigrationLedger({
        databaseUrl: databaseUrl?.toString() ?? '',
        migrationsDir,
        applyConnectorMigration: async () => {
          throw new Error('already-repaired ledgers must not reapply migrations');
        },
      }),
    ).toBe(false);

    const pending = await runner({
      ...runnerOptions,
      direction: 'up',
      count: Number.POSITIVE_INFINITY,
      checkOrder: true,
      dryRun: true,
    });
    const pendingNames = pending.map((migration) => migration.name);
    expect(pendingNames).not.toContain(migrationLedgerRepairConnectorName);
    expect(pendingNames).not.toContain('20260730000452547_sandbox_deadline');
    expect(pendingNames).not.toContain('20260730000452600_sandbox_deadline_index.concurrent');

    const client = new pg.Client({ connectionString: databaseUrl?.toString() });
    await client.connect();
    try {
      const ledger = await client.query<{ name: string }>(
        `select name
           from kortix_migrations.pgmigrations
          where name = any($1::text[])
          order by run_on, id`,
        [
          [
            migrationLedgerRepairConnectorName,
            '20260730000452547_sandbox_deadline',
            '20260730000452600_sandbox_deadline_index.concurrent',
          ],
        ],
      );
      expect(ledger.rows.map((row) => row.name)).toEqual([
        migrationLedgerRepairConnectorName,
        '20260730000452547_sandbox_deadline',
        '20260730000452600_sandbox_deadline_index.concurrent',
      ]);

      const columns = await client.query<{ count: number }>(
        `select count(*)::int
           from information_schema.columns
          where table_schema = 'kortix'
            and table_name like 'executor_%_policies'
            and column_name = 'conditions'`,
      );
      expect(columns.rows[0]?.count).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('repairs every applied renamed migration before strict order validation', async () => {
    const runnerOptions = {
      databaseUrl: piDatabaseUrl?.toString(),
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'kortix_migrations',
      createMigrationsSchema: true,
      singleTransaction: true,
      logger: console,
    } as const;

    expect(
      await repairMigrationLedger({
        databaseUrl: piDatabaseUrl?.toString() ?? '',
        migrationsDir,
        applyConnectorMigration: async () => {
          throw new Error('the pi rename must not reapply an existing migration');
        },
      }),
    ).toBe(true);

    const pending = await runner({
      ...runnerOptions,
      direction: 'up',
      count: Number.POSITIVE_INFINITY,
      checkOrder: true,
      dryRun: true,
    });
    expect(pending.map((migration) => migration.name)).not.toContain(
      '20260902070001000_pi_runtime_artifacts',
    );
    expect(pending.map((migration) => migration.name)).not.toContain(
      '20260805202913539_secret_consumer_boundary',
    );

    const client = new pg.Client({ connectionString: piDatabaseUrl?.toString() });
    await client.connect();
    try {
      const ledger = await client.query<{ name: string }>(
        `select name
           from kortix_migrations.pgmigrations
          where name = any($1::text[])
          order by run_on, id`,
        [
          [
            '20260828170156721_session_worker_log',
            '20260829160353474_pi_runtime_artifacts',
            '20260805165801277_secret_consumer_boundary',
            '20260805202913539_secret_consumer_boundary',
            '20260902070000000_session_worker_log',
            '20260902070001000_pi_runtime_artifacts',
          ],
        ],
      );
      expect(ledger.rows.map((row) => row.name)).toEqual([
        '20260805202913539_secret_consumer_boundary',
        '20260902070000000_session_worker_log',
        '20260902070001000_pi_runtime_artifacts',
      ]);
    } finally {
      await client.end();
    }
  });
});
