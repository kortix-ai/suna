/**
 * Integration test (real PostgreSQL): `createDb(url, { prepare: true })` makes
 * Drizzle statements server-side prepared statements.
 *
 * Two switches have to agree, and each alone is a no-op: postgres.js prepares
 * only when the CONNECTION option `prepare` is true AND the query's own option
 * is not false, and Drizzle sends every statement through `unsafe()`, whose
 * query option defaults to false. A run on 2026-09-19 set only the first and
 * measured nothing.
 */
import { afterAll, expect, test } from 'bun:test';
import { createDb } from '@kortix/db';
import { sql } from 'drizzle-orm';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
// One connection per client, so `pg_prepared_statements` (per connection) is
// read on the connection that ran the statement.
const prepared = createDb(url, { prepare: true, max: 1 });
const unprepared = createDb(url, { max: 1 });

afterAll(async () => {
  await Promise.all([prepared.$client.end(), unprepared.$client.end()]);
});

async function preparedCount(db: typeof prepared): Promise<number> {
  await db.execute(sql`select ${'a'}::text as value`);
  await db.execute(sql`select ${'b'}::text as value`);
  const rows = (await db.execute(
    sql`select count(*)::int as n from pg_prepared_statements where statement like 'select $1::text as value%'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

test('with prepare on, a parameterized Drizzle statement is prepared once on its connection', async () => {
  expect(await preparedCount(prepared)).toBe(1);
});

test('by default no Drizzle statement is prepared', async () => {
  expect(await preparedCount(unprepared)).toBe(0);
});
