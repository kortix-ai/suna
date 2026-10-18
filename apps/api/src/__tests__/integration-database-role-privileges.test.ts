/**
 * Integration test (real local DB): the role the DB suites connect as —
 * `postgres`, the API's role — can still SET `session_replication_role`
 * (KRTX-2026).
 *
 * A fresh Supabase stack ends its own init with
 * `ALTER ROLE postgres NOSUPERUSER ...`, so every SUSET parameter needs an
 * explicit privilege. The lane grants `SET ON PARAMETER session_replication_role`
 * to `postgres` at startup (tests/bin/db-suites.ts) so a suite that writes a
 * fixture past a trigger on the suites' own connection does not die mid-run
 * with `permission denied to set parameter`.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const { db } = await import('../shared/db');

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const first = (r: unknown) => ((r as Rows).rows ?? (r as Rows))[0];

async function replicationRole(): Promise<string> {
  const r = await db.execute(sql`SHOW session_replication_role`);
  return String(first(r).session_replication_role);
}

describe('the suites role can SET session_replication_role', () => {
  test('SET LOCAL inside a transaction applies and reverts with the transaction', async () => {
    expect(await replicationRole()).toBe('origin');

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      const inside = await tx.execute(sql`SHOW session_replication_role`);
      expect(String(first(inside).session_replication_role)).toBe('replica');
    });

    expect(await replicationRole()).toBe('origin');
  });
});
