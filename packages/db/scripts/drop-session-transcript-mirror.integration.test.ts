/**
 * The v1 transcript mirror drop (Session Log Plan P8.2, Release B3), against a real PostgreSQL.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL), where the migration has
 * already applied over an empty mirror. The guard cases rebuild the three tables with one mirror
 * row (only the columns the guard reads) and apply the file the way node-pg-migrate does (one
 * transaction), then roll back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const directory = resolve(import.meta.dir, '..', 'migrations');
const names = Array.from(new Bun.Glob('*_drop_session_transcript_mirror.sql').scanSync({ cwd: directory }));

const TABLES = `
  CREATE TABLE kortix.session_log_backfill_state (id text PRIMARY KEY, state jsonb NOT NULL, rev integer NOT NULL);
  CREATE TABLE kortix.session_transcript_mirrors (session_id text PRIMARY KEY);
  CREATE TABLE kortix.session_transcript_messages (
    session_id text NOT NULL REFERENCES kortix.session_transcript_mirrors (session_id) ON DELETE CASCADE,
    message_id text NOT NULL);
  INSERT INTO kortix.session_transcript_mirrors VALUES ('s1');
  INSERT INTO kortix.session_transcript_messages VALUES ('s1', 'm1');`;
const passState = (state: Record<string, boolean>) =>
  `INSERT INTO kortix.session_log_backfill_state (id, state, rev) VALUES ('pass', '${JSON.stringify(state)}'::jsonb, 1);`;
const DONE = passState({ drainedWithDeleted: true, mergedMissing: true });
const RELATIONS = ['kortix.session_transcript_mirrors', 'kortix.session_transcript_messages', 'kortix.session_log_backfill_state'];

suite('drop the v1 transcript mirror and the backfill state', () => {
  let client: pg.Client;
  let migration = '';
  const present = async (relation: string) =>
    (await client.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [relation])).rows[0]!.present;
  const presentAll = async () => Promise.all(RELATIONS.map(present));
  const functions = async () =>
    (
      await client.query<{ name: string }>(
        `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kortix' AND p.proname IN ('mirror_messages_missing_from_log', 'mirror_sessions_without_log', 'session_delete_due_at')
          ORDER BY 1`,
      )
    ).rows.map((r) => r.name);
  /** One case in its own transaction: `setup`, then the migration; rolled back after `check`. */
  const attempt = async (setup: string, check: (applied: Error | null) => Promise<void>) => {
    await client.query('BEGIN');
    try {
      await client.query(setup);
      await client.query('SAVEPOINT apply');
      const applied = await client.query(migration).then(
        () => null,
        (err: Error) => err,
      );
      if (applied) await client.query('ROLLBACK TO SAVEPOINT apply');
      await check(applied);
    } finally {
      await client.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    expect(names).toHaveLength(1);
    migration = readFileSync(resolve(directory, names[0]!), 'utf8');
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  test('a fresh database migrates over an empty mirror: the three tables and both mirror functions are gone, the purge function stays', async () => {
    const applied = await client.query('SELECT 1 FROM kortix_migrations.pgmigrations WHERE name = $1', [names[0]!.replace(/\.sql$/, '')]);
    expect(applied.rowCount).toBe(1);
    expect(await presentAll()).toEqual([false, false, false]);
    expect(await functions()).toEqual(['session_delete_due_at']);
  });

  test('a mirror with rows and no backfill state row: refused with the operator hint, nothing dropped', async () => {
    await attempt(TABLES, async (err) => {
      expect(err?.message).toContain('session_transcript_mirrors drop refused: the v1 mirror holds rows and the session-log backfill has not finished');
      expect(err?.message).toContain('drainedWithDeleted=unset, mergedMissing=unset');
      expect((err as { hint?: string } | null)?.hint).toContain('the session logs hold every v1 mirror message');
      expect(await presentAll()).toEqual([true, true, true]);
    });
  });

  test('drained but not merged: refused, nothing dropped', async () => {
    await attempt(`${TABLES} ${passState({ drainedWithDeleted: true, mergedMissing: false })}`, async (err) => {
      expect(err?.message).toContain('drainedWithDeleted=true, mergedMissing=false');
      expect(await presentAll()).toEqual([true, true, true]);
    });
  });

  test('drained and merged: the three tables dropped', async () => {
    await attempt(`${TABLES} ${DONE}`, async (err) => {
      expect(err).toBeNull();
      expect(await presentAll()).toEqual([false, false, false]);
    });
  });

  test('a SQL function that still reads a dropped table: refused, named, nothing dropped', async () => {
    const reader = `CREATE FUNCTION public.reads_backfill_state() RETURNS bigint LANGUAGE plpgsql
      AS $f$ BEGIN RETURN (SELECT count(*) FROM kortix.session_log_backfill_state); END $f$;`;
    await attempt(`${TABLES} ${DONE} ${reader}`, async (err) => {
      expect(err?.message).toContain('public.reads_backfill_state() references a dropped table');
      expect(await presentAll()).toEqual([true, true, true]);
    });
  });

  test('a view over the mirror: the RESTRICT drop refuses instead of taking the view', async () => {
    const view = 'CREATE VIEW public.v1_mirror_view AS SELECT session_id FROM kortix.session_transcript_mirrors;';
    await attempt(`${TABLES} ${DONE} ${view}`, async (err) => {
      expect(err?.message).toContain('cannot drop table kortix.session_transcript_mirrors because other objects depend on it');
      expect(await present('public.v1_mirror_view')).toBe(true);
    });
  });
});
