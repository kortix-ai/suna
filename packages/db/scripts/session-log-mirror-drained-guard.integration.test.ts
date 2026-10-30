/**
 * The Release B2 guard (Session Log Plan P8.2), against a real PostgreSQL: a database whose v1
 * mirror still holds rows runs B2 only once the backfill's state row says both passes finished.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL), where the guard has
 * already passed over an empty mirror. Each case seeds one mirror row (foreign keys off for the
 * transaction: the guard reads only that a row exists) and a state row, applies the file the way
 * node-pg-migrate does (one transaction), then rolls back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const directory = resolve(import.meta.dir, '..', 'migrations');
const names = Array.from(new Bun.Glob('*_session_log_mirror_drained_guard.sql').scanSync({ cwd: directory }));

const MIRROR_ROW = `
  SET LOCAL session_replication_role = replica;
  INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id)
    VALUES ('guard-test', gen_random_uuid(), gen_random_uuid());`;
const passState = (state: Record<string, boolean>) =>
  `INSERT INTO kortix.session_log_backfill_state (id, state, rev) VALUES ('pass', '${JSON.stringify(state)}'::jsonb, 1)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state;`;

suite('the Release B2 guard: no release without a finished backfill', () => {
  let client: pg.Client;
  let migration = '';
  /** One case in its own transaction: `setup`, then the guard; rolled back after. */
  const attempt = async (setup: string): Promise<Error | null> => {
    await client.query('BEGIN');
    try {
      await client.query(setup);
      return await client.query(migration).then(
        () => null,
        (err: Error) => err,
      );
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

  test('a fresh database (empty mirror) passes, and the mirror tables stay', async () => {
    const applied = await client.query('SELECT 1 FROM kortix_migrations.pgmigrations WHERE name = $1', [names[0]!.replace(/\.sql$/, '')]);
    expect(applied.rowCount).toBe(1);
    const tables = await client.query<{ present: boolean }>(
      `SELECT to_regclass(t) IS NOT NULL AS present FROM unnest(ARRAY['kortix.session_transcript_mirrors', 'kortix.session_transcript_messages', 'kortix.session_log_backfill_state']) t`,
    );
    expect(tables.rows.map((r) => r.present)).toEqual([true, true, true]);
  });

  test('a mirror with rows and no state row: refused with the operator hint', async () => {
    const err = await attempt(`${MIRROR_ROW} DELETE FROM kortix.session_log_backfill_state;`);
    expect(err?.message).toContain('session log release refused: the v1 mirror holds rows and the session-log backfill has not finished');
    expect(err?.message).toContain('drainedWithDeleted=unset, mergedMissing=unset');
    expect((err as { hint?: string } | null)?.hint).toContain('Run Kortix 0.14.9 until its API logs "the session logs hold every v1 mirror message"');
  });

  test('drained but not merged: refused', async () => {
    const err = await attempt(`${MIRROR_ROW} ${passState({ drainedWithDeleted: true, mergedMissing: false })}`);
    expect(err?.message).toContain('drainedWithDeleted=true, mergedMissing=false');
  });

  test('drained and merged: passes', async () => {
    expect(await attempt(`${MIRROR_ROW} ${passState({ drainedWithDeleted: true, mergedMissing: true })}`)).toBeNull();
  });
});
