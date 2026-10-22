/**
 * Integration test (real PostgreSQL, fresh migrated database): no client role
 * reaches a `kortix` table. PostgREST exposes the schema, so isolation must not
 * rest on grants alone (pentest M-3): every table has RLS on, and anon,
 * authenticated and authenticator hold no table privilege.
 *
 * A new table fails this test until its migration enables RLS:
 *   ALTER TABLE kortix.<table> ENABLE ROW LEVEL SECURITY;
 */
import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '../shared/db';

test('every kortix table has row level security on', async () => {
  const rows = (await db.execute(sql`
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'kortix' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity
     ORDER BY 1`)) as unknown as Array<{ relname: string }>;
  expect(rows.map((r) => r.relname)).toEqual([]);
});

test('anon, authenticated and authenticator hold no privilege on any kortix table', async () => {
  const rows = (await db.execute(sql`
    SELECT grantee || ' ' || privilege_type || ' ' || table_name AS grant
      FROM information_schema.role_table_grants
     WHERE table_schema = 'kortix' AND grantee IN ('anon', 'authenticated', 'authenticator', 'PUBLIC')
     ORDER BY 1`)) as unknown as Array<{ grant: string }>;
  expect(rows.map((r) => r.grant)).toEqual([]);
});
