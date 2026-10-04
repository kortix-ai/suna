import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';
import { applyBootstrap, databaseConnectionUrl, migrationOptions, migrationsDir } from './upgrade-test-helpers';

const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL;
const ACCOUNT = 'd7900000-0000-4000-a000-000000000001';

/**
 * The swap on a database that already has audit history, with a connection that stays
 * open across it. Proves: legacy rows are not moved or lost, they stay readable through
 * audit_events_all, and a statement a pooled connection prepared BEFORE the swap writes to
 * the new partitioned table AFTER it (plan invalidation by rename).
 */
describe.skipIf(!databaseUrl)('audit_events partition cutover — upgrade of a database with history', () => {
  test(
    'keeps history readable, keeps pooled prepared statements working, and swaps in milliseconds',
    async () => {
      const databaseName = `audit_cutover_${randomUUID().replaceAll('-', '')}`;
      const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
      await admin.end();

      const url = databaseConnectionUrl(databaseUrl!, databaseName);
      const pooled = new pg.Client({ connectionString: url });
      try {
        const setup = new pg.Client({ connectionString: url });
        await setup.connect();
        await applyBootstrap(setup);
        await setup.end();

        const files = readdirSync(runtimeMigrations.path)
          .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
          .sort();
        // Everything up to and including the read-view migration: the state of the previous release.
        const beforeCutover = files.findIndex((name) => name.startsWith('20261001225732090_')); // first cutover migration
        expect(beforeCutover).toBeGreaterThan(0);
        await runner({
          ...migrationOptions(url, runtimeMigrations.path),
          direction: 'up',
          count: beforeCutover,
        });

        await pooled.connect();
        await pooled.query(`INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'cutover')`, [ACCOUNT]);
        await pooled.query(
          `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
           SELECT $1, 'test.cutover.history', 'test', 'system', now() - n * interval '1 hour'
             FROM generate_series(1, 500) n`,
          [ACCOUNT],
        );
        // Prepared (named) statements: the pool's connection has planned them against the OLD table.
        const insertSql = {
          name: 'cutover-insert',
          text: `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
                 VALUES ($1, 'test.cutover.after', 'test', 'system')
                 RETURNING tableoid::regclass::text AS partition`,
          values: [ACCOUNT],
        };
        const readSql = {
          name: 'cutover-read',
          text: `SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE account_id = $1`,
          values: [ACCOUNT],
        };
        for (let i = 0; i < 6; i += 1) await pooled.query(readSql); // past the custom-plan threshold
        const first = await pooled.query<{ partition: string }>(insertSql);
        expect(first.rows[0]?.partition).toBe('kortix.audit_events');
        const historyBefore = (await pooled.query<{ n: number }>(readSql)).rows[0]!.n;
        expect(historyBefore).toBe(501);

        // The swap, timed on its own.
        const started = Date.now();
        const cutoverFiles = files.filter((name) => name >= '20261001225732090_');
        expect(cutoverFiles.length).toBeGreaterThanOrEqual(3);
        await runner({
          ...migrationOptions(url, runtimeMigrations.path),
          direction: 'up',
          count: Number.POSITIVE_INFINITY,
        });
        // Whole three migrations, including the first-ever creation of 22 partitions, on an empty cache.
        expect(Date.now() - started).toBeLessThan(10_000);

        // The same pooled connection, the same prepared statements.
        const after = await pooled.query<{ partition: string }>(insertSql);
        expect(after.rows[0]?.partition).toMatch(/^kortix\.audit_events_p\d{8}$/);
        expect((await pooled.query<{ n: number }>(readSql)).rows[0]!.n).toBe(502); // history + 1 old-table row + 1 new row

        const legacy = await pooled.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM kortix.audit_events_legacy WHERE account_id = $1`,
          [ACCOUNT],
        );
        expect(legacy.rows[0]?.n).toBe(501); // not moved, not copied, not lost
        const hot = await pooled.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM kortix.audit_events WHERE account_id = $1`,
          [ACCOUNT],
        );
        expect(hot.rows[0]?.n).toBe(1);
      } finally {
        await pooled.end().catch(() => {});
        runtimeMigrations.cleanup();
        const cleanup = new pg.Client({ connectionString: databaseUrl });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await cleanup.end();
      }
    },
    120_000,
  );
});
