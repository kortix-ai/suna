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

// A generic plan (PostgreSQL's choice after ~5 executions of a prepared
// statement) cannot use a partial index whose predicate arrives as a parameter.
// Prepared connections keep a custom plan per execution, as unprepared ones do.
async function planCacheMode(db: typeof prepared): Promise<string | undefined> {
  const rows = (await db.execute(sql`select current_setting('plan_cache_mode') as mode`)) as unknown as Array<{
    mode: string;
  }>;
  return rows[0]?.mode;
}

test('with prepare on, every execution is planned for its own parameters', async () => {
  expect(await planCacheMode(prepared)).toBe('force_custom_plan');
});

test('by default the server plan cache setting is untouched', async () => {
  expect(await planCacheMode(unprepared)).toBe('auto');
});
