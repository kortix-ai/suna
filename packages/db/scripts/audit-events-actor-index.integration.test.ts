import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { databaseConnectionUrl, migrationOptions } from './upgrade-test-helpers';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const migration = '20261003045411159_audit_events_actor_aggregate_index.concurrent.ts';

describe.skipIf(!adminUrl)('audit actor aggregate covering index', () => {
  test('covers range and default partitions, preserves aggregates and indexes future partitions', async () => {
    if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL required');
    const name = `actor_index_${randomUUID().replaceAll('-', '')}`;
    const directory = mkdtempSync(join(tmpdir(), 'actor-index-'));
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = databaseConnectionUrl(adminUrl, name);
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA kortix;
        CREATE TABLE kortix.audit_events(account_id uuid, actor_type text, occurred_at timestamptz, actor_user_id uuid)
        PARTITION BY RANGE (occurred_at);
        CREATE TABLE kortix.audit_events_test PARTITION OF kortix.audit_events
          FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
        CREATE TABLE kortix.audit_events_default PARTITION OF kortix.audit_events DEFAULT;
        INSERT INTO kortix.audit_events SELECT '00000000-0000-4000-a000-000000000001',
          CASE WHEN n % 2 = 0 THEN 'human' ELSE 'agent' END,
          '2026-01-01'::timestamptz + n * interval '1 minute',
          CASE WHEN n % 3 = 0 THEN NULL ELSE '00000000-0000-4000-a000-000000000002'::uuid END
          FROM generate_series(1, 60000) n;`);
      const aggregate = `SELECT count(distinct actor_user_id)::int AS actors, count(*)::int AS events,
        count(distinct actor_user_id) FILTER (WHERE actor_user_id <> '00000000-0000-4000-a000-000000000003')::int AS others
        FROM kortix.audit_events WHERE account_id = '00000000-0000-4000-a000-000000000001'
        AND actor_type = 'human' AND occurred_at >= '2026-01-01' AND occurred_at < '2026-03-01'`;
      const before = await client.query(aggregate);
      expect(before.rows).toEqual([{ actors: 1, events: 30000, others: 1 }]);
      writeFileSync(
        join(directory, '20261003045411000_before.sql'),
        'CREATE TABLE kortix.before_index(id integer);',
      );
      copyFileSync(
        join(import.meta.dir, '..', 'migrations', migration),
        join(directory, migration),
      );
      writeFileSync(
        join(directory, '20261003045412000_after.sql'),
        'CREATE TABLE kortix.after_index(id integer);',
      );
      await runner({ ...migrationOptions(url, directory), direction: 'up' });
      const indexes = await client.query(`SELECT i.indisvalid, i.indnkeyatts, i.indnatts,
        pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
        WHERE i.indexrelid = to_regclass('kortix.idx_audit_events_account_actor_type_time')
        OR i.indexrelid IN (SELECT inhrelid FROM pg_inherits
          WHERE inhparent = to_regclass('kortix.idx_audit_events_account_actor_type_time'))`);
      expect(indexes.rows).toHaveLength(3);
      for (const index of indexes.rows) {
        expect(index.indisvalid).toBe(true);
        expect(index.indnkeyatts).toBe(3);
        expect(index.indnatts).toBe(4);
        expect(index.definition).toContain(
          '(account_id, actor_type, occurred_at) INCLUDE (actor_user_id)',
        );
      }
      await client.query('VACUUM ANALYZE kortix.audit_events');
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(`EXPLAIN (FORMAT JSON) ${aggregate}`);
      const planText = JSON.stringify(plan.rows);
      expect(planText).toContain('Index Only Scan');
      expect(planText).not.toContain('Seq Scan');
      expect((await client.query(aggregate)).rows).toEqual(before.rows);
      await runner({ ...migrationOptions(url, directory), direction: 'up' });
      // Simulate an interrupted run after the indexes attached but before ledger insertion.
      await client.query('DELETE FROM kortix_migrations.pgmigrations');
      await client.query('DROP TABLE kortix.before_index, kortix.after_index');
      await runner({ ...migrationOptions(url, directory), direction: 'up' });
      const lock = await client.query(`SELECT pg_try_advisory_lock(
        hashtextextended('kortix.audit_events_ensure_partitions', 0)) AS acquired`);
      expect(lock.rows).toEqual([{ acquired: true }]);
      await client.query(
        `SELECT pg_advisory_unlock(hashtextextended('kortix.audit_events_ensure_partitions', 0))`,
      );
      await client.query(`CREATE TABLE kortix.audit_events_future (LIKE kortix.audit_events INCLUDING DEFAULTS);
        ALTER TABLE kortix.audit_events ATTACH PARTITION kortix.audit_events_future
          FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');`);
      const future = await client.query(`SELECT i.indisvalid, i.indnatts FROM pg_index i
        JOIN pg_inherits h ON h.inhrelid = i.indexrelid
        WHERE h.inhparent = 'kortix.idx_audit_events_account_actor_type_time'::regclass
          AND i.indrelid = 'kortix.audit_events_future'::regclass`);
      expect(future.rows).toEqual([{ indisvalid: true, indnatts: 4 }]);
      expect(
        (await client.query("SELECT to_regclass('kortix.after_index') IS NOT NULL AS applied"))
          .rows,
      ).toEqual([{ applied: true }]);
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
});
