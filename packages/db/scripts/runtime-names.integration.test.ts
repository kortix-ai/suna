/**
 * The runtime-names migrations on a migrated PostgreSQL:
 * `20261105174320852_runtime_names.sql` renames the OpenCode-named columns
 * (and recreates the session audit trigger that names one), and
 * `20261105174525378_session_metadata_runtime_keys.concurrent.ts` renames the
 * OpenCode-era keys in `project_sessions.metadata`. Synthetic fixtures only.
 * Runs the backfill's own `up()` twice to prove it is idempotent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const backfillPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20261105174525378_session_metadata_runtime_keys.concurrent.ts',
);

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const TRIGGER_SESSION = `runtime-names-trigger-${crypto.randomUUID()}`;
const OLD_KEYS_SESSION = `runtime-names-old-${crypto.randomUUID()}`;
const BOTH_KEYS_SESSION = `runtime-names-both-${crypto.randomUUID()}`;
const NEW_KEYS_SESSION = `runtime-names-new-${crypto.randomUUID()}`;

let client: pg.Client;

async function runBackfill() {
  const migration = (await import(backfillPath)) as { up: (pgm: unknown) => Promise<void> };
  await migration.up({
    noTransaction: () => undefined,
    sql: () => undefined,
    db: { query: (text: string) => client.query(text) },
  });
}

async function metadataOf(sessionId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query(`select metadata from kortix.project_sessions where session_id = $1`, [sessionId]);
  return rows[0].metadata;
}

describe.skipIf(!databaseUrl)('runtime names — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`insert into kortix.accounts (account_id, name) values ($1, 'runtime-names')`, [ACCOUNT]);
    await client.query(
      `insert into kortix.projects (project_id, account_id, name, repo_url)
       values ($1, $2, 'runtime-names', 'https://example.invalid/runtime-names.git')`,
      [PROJECT, ACCOUNT],
    );
  });

  afterAll(async () => {
    await client?.query(`delete from kortix.project_sessions where project_id = $1`, [PROJECT]);
    await client?.query(`delete from kortix.projects where project_id = $1`, [PROJECT]);
    await client?.query(`delete from kortix.accounts where account_id = $1`, [ACCOUNT]);
    await client?.end();
  });

  test('no kortix relation has a column named after OpenCode; the renamed columns exist', async () => {
    const { rows } = await client.query<{ relation: string; column_name: string }>(
      `select table_name as relation, column_name from information_schema.columns
        where table_schema = 'kortix'
          and (column_name like 'opencode%'
               or (table_name, column_name) in (
                 ('project_sessions', 'runtime_session_id'), ('session_turns', 'runtime_session_id'),
                 ('session_runtime_projections', 'runtime_session_id'), ('session_runtime_projections', 'harness_version'),
                 ('session_pending_questions', 'runtime_session_id'), ('chat_channel_bindings', 'model'),
                 ('audit_events', 'runtime_session_id'), ('audit_events_all', 'runtime_session_id')))
        order by 1, 2`,
    );
    expect(rows.filter((r) => r.column_name.startsWith('opencode'))).toEqual([]);
    expect(rows.map((r) => `${r.relation}.${r.column_name}`)).toEqual(
      expect.arrayContaining([
        'audit_events.runtime_session_id',
        'audit_events_all.runtime_session_id',
        'chat_channel_bindings.model',
        'project_sessions.runtime_session_id',
        'session_pending_questions.runtime_session_id',
        'session_runtime_projections.harness_version',
        'session_runtime_projections.runtime_session_id',
        'session_turns.runtime_session_id',
      ]),
    );
  });

  test('the session audit trigger records the runtime session id on create and on a status change', async () => {
    await client.query(
      `insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, runtime_session_id)
       values ($1, $2, $3, 'runtime-names', 'ses_pi_runtime_names')`,
      [TRIGGER_SESSION, ACCOUNT, PROJECT],
    );
    await client.query(`update kortix.project_sessions set status = 'running' where session_id = $1`, [TRIGGER_SESSION]);
    const { rows } = await client.query<{ action: string; runtime_session_id: string }>(
      `select action, runtime_session_id from kortix.audit_events_all
        where session_id = $1 and resource_type = 'project_session' order by occurred_at, action`,
      [TRIGGER_SESSION],
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['session.created', 'session.status.changed']);
    expect(rows.every((r) => r.runtime_session_id === 'ses_pi_runtime_names')).toBe(true);
  });

  test('the backfill renames every OpenCode-era metadata key, keeps values and other keys, and is idempotent', async () => {
    const runtimeSessions = [{ id: 'ses_pi_a', parent_id: null, title: 'Root', archived: false }];
    await client.query(
      `insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, metadata) values
         ($1, $4, $5, 'old', $6::jsonb), ($2, $4, $5, 'both', $7::jsonb), ($3, $4, $5, 'new', $8::jsonb)`,
      [
        OLD_KEYS_SESSION,
        BOTH_KEYS_SESSION,
        NEW_KEYS_SESSION,
        ACCOUNT,
        PROJECT,
        JSON.stringify({
          name: 'Kept',
          opencode_model: 'kortix/glm-5.3',
          opencode_model_source: 'fallback',
          opencode_model_picked_at: 1793900000000,
          opencode_model_restored: true,
          opencode_model_repointed_from: 'kortix/old-model',
          opencode_model_fallback_from: 'claude-agent/opus',
          opencode_model_fallback_from_source: 'explicit',
          opencode_model_fallback_reason: 'plan_limit',
          opencode_model_fallback_at: 1793900000001,
          opencode_model_fallback_until: 1793900000002,
          opencode_sessions: runtimeSessions,
        }),
        // An old key the previous API wrote during the rollout, after an earlier run: it is newer.
        JSON.stringify({ model: 'kortix/stale', model_source: 'explicit', opencode_model: 'kortix/newer' }),
        JSON.stringify({ model: 'kortix/current', model_source: 'project' }),
      ],
    );

    await runBackfill();
    await runBackfill();

    expect(await metadataOf(OLD_KEYS_SESSION)).toEqual({
      name: 'Kept',
      model: 'kortix/glm-5.3',
      model_source: 'fallback',
      model_picked_at: 1793900000000,
      model_restored: true,
      model_repointed_from: 'kortix/old-model',
      model_fallback_from: 'claude-agent/opus',
      model_fallback_from_source: 'explicit',
      model_fallback_reason: 'plan_limit',
      model_fallback_at: 1793900000001,
      model_fallback_until: 1793900000002,
      runtime_sessions: runtimeSessions,
    });
    expect(await metadataOf(BOTH_KEYS_SESSION)).toEqual({ model: 'kortix/newer', model_source: 'explicit' });
    expect(await metadataOf(NEW_KEYS_SESSION)).toEqual({ model: 'kortix/current', model_source: 'project' });
  });
});
