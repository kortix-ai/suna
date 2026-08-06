import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.CONNECTOR_CUTOVER_DATABASE_URL;

const LEGACY_RELATIONS = [
  'executor_connectors',
  'executor_connector_actions',
  'executor_connector_grants',
  'executor_connector_policies',
  'executor_project_policies',
  'executor_project_settings',
  'executor_attachments',
  'executor_connection_profiles',
  'executor_credentials',
  'executor_executions',
  'executor_oauth_applications',
  'executor_oauth_sessions',
  'executor_connection_policies',
] as const;

describe.skipIf(!databaseUrl)('connector compatibility removal — migrated PostgreSQL', () => {
  test('removes every executor compatibility relation', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'kortix' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [LEGACY_RELATIONS],
      );
      expect(result.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('stores one required connection_id without synchronization machinery', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const columns = await client.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'kortix'
           AND table_name = 'project_session_connector_bindings'
           AND column_name IN ('connection_id', 'profile_id')
         ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([{ column_name: 'connection_id', is_nullable: 'NO' }]);

      const trigger = await client.query(
        `SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'kortix'
           AND c.relname = 'project_session_connector_bindings'
           AND t.tgname = 'sync_session_connector_binding_connection_ids'
           AND NOT t.tgisinternal`,
      );
      expect(trigger.rowCount).toBe(0);

      const fn = await client.query(
        `SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'kortix'
           AND p.proname = 'sync_session_connector_binding_connection_ids'`,
      );
      expect(fn.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('uses connector as the only connector secret consumer enum value', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const values = await client.query<{ enumlabel: string }>(
        `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'kortix' AND t.typname = 'project_secret_consumer'
         ORDER BY e.enumsortorder`,
      );
      expect(values.rows.map((row) => row.enumlabel)).toEqual([
        'sandbox',
        'llm_gateway',
        'connector',
        'git_proxy',
        'http_broker',
        'network',
      ]);

      const legacyRows = await client.query(
        `SELECT 1 FROM kortix.project_secrets WHERE consumer::text = 'executor' LIMIT 1`,
      );
      expect(legacyRows.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
