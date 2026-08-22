// The `llm_gateway` project-override cleanup, executed by a REAL PostgreSQL.
//
// `20260822164008106_drop_llm_gateway_project_override.sql` removes the stale
// `metadata.experimental.llm_gateway` sub-key (the flag is retired: gateway
// mode is the only session mode). This test runs that file's statements
// inside ONE transaction against a migrated database and rolls back, so it is
// safe against a shared local DB and asserts exactly three things:
//
//   1. a row carrying the key loses ONLY that key — sibling flags survive;
//   2. a row without the key is untouched (`updated_at` byte-identical);
//   3. re-running matches zero rows (idempotent).
//
// Gate: set DROP_LLM_GATEWAY_OVERRIDE_DATABASE_URL to a database that already
// has the kortix schema (any local stack DB). Skipped otherwise.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DROP_LLM_GATEWAY_OVERRIDE_DATABASE_URL;

const MIGRATION = join(
  import.meta.dir,
  '..',
  'migrations',
  '20260822164008106_drop_llm_gateway_project_override.sql',
);

describe.skipIf(!databaseUrl)('drop_llm_gateway_project_override — migrated PostgreSQL', () => {
  test('removes only the stale key, leaves other rows untouched, and is idempotent', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const account = crypto.randomUUID();
    const withKey = crypto.randomUUID();
    const withoutKey = crypto.randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO kortix.accounts (account_id, name) VALUES ($1, 'drop-llm-gateway-override-test')`,
        [account],
      );
      await client.query(
        `INSERT INTO kortix.projects (project_id, account_id, name, repo_url, metadata, updated_at)
         VALUES ($1, $2, 'with-key', 'https://example.test/with-key.git',
                 '{"experimental":{"llm_gateway":false,"review_center":true},"default_agent":"x"}'::jsonb,
                 now() - interval '1 day'),
                ($3, $2, 'without-key', 'https://example.test/without-key.git',
                 '{"experimental":{"review_center":true}}'::jsonb,
                 now() - interval '1 day')`,
        [withKey, account, withoutKey],
      );
      const before = await client.query<{ project_id: string; updated_at: string }>(
        `SELECT project_id, updated_at::text FROM kortix.projects WHERE project_id = ANY($1::uuid[])`,
        [[withKey, withoutKey]],
      );
      const updatedAtBefore = Object.fromEntries(before.rows.map((r) => [r.project_id, r.updated_at]));

      // The file is plain SQL (SET + one UPDATE); pg runs multi-statement text.
      const first = await client.query(sql);
      const firstUpdate = (Array.isArray(first) ? first : [first]).find((r) => r.command === 'UPDATE');
      // ≥ 1: the seeded row, plus whatever real rows the target DB still
      // carries (a shared local DB is allowed here — everything rolls back).
      expect(firstUpdate?.rowCount ?? 0).toBeGreaterThanOrEqual(1);
      console.log(`[drop_llm_gateway_project_override] rows rewritten: ${firstUpdate?.rowCount}`);

      const after = await client.query<{
        project_id: string;
        metadata: Record<string, unknown>;
        updated_at: string;
      }>(
        `SELECT project_id, metadata, updated_at::text FROM kortix.projects WHERE project_id = ANY($1::uuid[])`,
        [[withKey, withoutKey]],
      );
      const rows = Object.fromEntries(after.rows.map((r) => [r.project_id, r]));
      // 1. only the key is gone; the sibling flag and unrelated metadata survive.
      expect(rows[withKey]!.metadata).toEqual({
        experimental: { review_center: true },
        default_agent: 'x',
      });
      // 2. the row without the key is byte-identical (no spurious write).
      expect(rows[withoutKey]!.metadata).toEqual({ experimental: { review_center: true } });
      expect(rows[withoutKey]!.updated_at).toBe(updatedAtBefore[withoutKey]!);

      // 3. idempotent: a second run matches nothing.
      const second = await client.query(sql);
      const secondUpdate = (Array.isArray(second) ? second : [second]).find((r) => r.command === 'UPDATE');
      expect(secondUpdate?.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
