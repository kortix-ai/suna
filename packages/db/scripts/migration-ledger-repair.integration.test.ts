import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import {
  migrationLedgerRepairExecutorName,
  repairMigrationLedger,
} from './migration-ledger-repair';

const adminUrl = process.env.MIGRATION_REPAIR_ADMIN_URL;
const suite = adminUrl ? describe : describe.skip;
const migrationsDir = join(import.meta.dir, '..', 'migrations');
const databaseName = `kortix_migration_repair_${process.pid}_${Date.now()}`;
const databaseUrl = adminUrl ? new URL(adminUrl) : null;
if (databaseUrl) databaseUrl.pathname = `/${databaseName}`;

let admin: pg.Client;

suite('migration ledger rename repair', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);

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
        .filter((filename) => filename.endsWith('.sql') || filename.endsWith('.concurrent.ts'))
        .sort()
        .map((filename) => filename.replace(/\.sql$/, '').replace(/\.ts$/, ''));
      const executorIndex = migrationNames.indexOf(migrationLedgerRepairExecutorName);
      expect(executorIndex).toBeGreaterThan(0);

      for (const [index, name] of migrationNames.slice(0, executorIndex).entries()) {
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
  });

  afterAll(async () => {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
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
      applyExecutorMigration: async () => {
        await runner({
          ...runnerOptions,
          direction: 'up',
          count: 1,
          checkOrder: false,
          file: migrationLedgerRepairExecutorName,
        });
      },
    });

    expect(repaired).toBe(true);
    expect(
      await repairMigrationLedger({
        databaseUrl: databaseUrl?.toString() ?? '',
        migrationsDir,
        applyExecutorMigration: async () => {
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
    expect(pendingNames).not.toContain(migrationLedgerRepairExecutorName);
    expect(pendingNames).not.toContain('20260730000452547_sandbox_deadline');
    expect(pendingNames).not.toContain('20260730000452600_sandbox_deadline_index.concurrent');

    const client = new pg.Client({ connectionString: databaseUrl?.toString() });
    await client.connect();
    try {
      const ledger = await client.query<{ name: string }>(
        `select name
           from kortix_migrations.pgmigrations
          order by run_on, id`,
      );
      expect(ledger.rows.slice(-3).map((row) => row.name)).toEqual([
        migrationLedgerRepairExecutorName,
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
});
