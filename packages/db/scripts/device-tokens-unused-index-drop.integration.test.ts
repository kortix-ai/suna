/** Apply the real runner to the legacy-table shape recorded on KRTX-1231.
 * Fresh installs have no public.device_tokens; product notifications instead
 * use kortix.push_device_tokens. Keep rows and constraints on legacy installs.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const client = new pg.Client({ connectionString: databaseUrl });
const directory = mkdtempSync(join(tmpdir(), 'device-tokens-drop-'));
const migrations = [
  '20261020174500000_drop_device_tokens_account_id_index.concurrent.ts',
  '20261020174500001_drop_device_tokens_active_index.concurrent.ts',
];
for (const name of migrations)
  copyFileSync(join(import.meta.dir, '../migrations', name), join(directory, name));
/** node-pg-migrate records the file basename without the `.ts` extension. */
const ledgerNames = migrations.map((name) => name.replace(/\.ts$/, ''));

/** The two indexes the Supabase advisor flags as unused and the drops remove. */
const DROPPED_INDEXES = ['idx_device_tokens_account_id', 'idx_device_tokens_active'];

async function apply() {
  await runner({
    databaseUrl,
    dir: directory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'device_tokens_drop_test',
    createMigrationsSchema: true,
    singleTransaction: true,
    log: () => {},
  });
}

async function reset() {
  await client.query('DROP TABLE IF EXISTS public.device_tokens');
  await client.query('DROP SCHEMA IF EXISTS device_tokens_drop_test CASCADE');
}

/**
 * The prod shape as recorded on the issue (2026-10-04): a primary key, one
 * unique constraint, and the two flagged secondary indexes. The drop targets
 * indexes by name, so the exact prod column set does not change the outcome;
 * the shape here carries every column the assertions touch.
 */
async function createProdShape() {
  await client.query(`
    create table public.device_tokens (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null,
      token text not null,
      platform text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `);
  await client.query(
    'create index idx_device_tokens_account_id on public.device_tokens (account_id)',
  );
  await client.query('create index idx_device_tokens_active on public.device_tokens (active)');
  await client.query(
    'alter table public.device_tokens add constraint device_tokens_token_key unique (token)',
  );
}

beforeAll(async () => {
  await client.connect();
  await reset();
});
afterAll(async () => {
  await reset();
  await client.end();
  rmSync(directory, { recursive: true });
});

test('a fresh installation stays without the orphan table', async () => {
  await apply();
  const { rows } = await client.query("SELECT to_regclass('public.device_tokens') AS relation");
  expect(rows[0].relation).toBeNull();
  const ledger = await client.query(
    'SELECT name FROM device_tokens_drop_test.pgmigrations ORDER BY name',
  );
  expect(ledger.rows.map((r) => r.name)).toEqual(ledgerNames);
});

test('the drops remove exactly the two unused indexes and keep the constraints', async () => {
  await reset();
  await createProdShape();
  const token = '11111111-1111-4111-8111-111111111111';
  await client.query(
    `INSERT INTO public.device_tokens (account_id, token, platform) VALUES ('${token}', 'synthetic-device-token', 'ios')`,
  );
  await apply();

  const dropped = await client.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index x ON x.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [DROPPED_INDEXES],
  );
  expect(dropped.rows.map((r) => r.relname).sort()).toEqual([]);

  const constraints = await client.query<{
    conname: string;
    contype: string;
    indisvalid: boolean;
  }>(`
    SELECT c.conname, c.contype::text, i.indisvalid
      FROM pg_constraint c
      JOIN pg_index i ON i.indexrelid = c.conindid
     WHERE c.conrelid = 'public.device_tokens'::regclass
       AND c.contype IN ('p', 'u')
  `);
  expect(constraints.rows.sort((a, b) => a.conname.localeCompare(b.conname))).toEqual([
    { conname: 'device_tokens_pkey', contype: 'p', indisvalid: true },
    { conname: 'device_tokens_token_key', contype: 'u', indisvalid: true },
  ]);

  expect((await client.query('SELECT token FROM public.device_tokens')).rows).toEqual([
    { token: 'synthetic-device-token' },
  ]);
  await expect(
    client.query(
      `INSERT INTO public.device_tokens (account_id, token, platform) VALUES ('${token}', 'synthetic-device-token', 'ios')`,
    ),
  ).rejects.toMatchObject({ code: '23505' });

  // Re-run safety: a fresh ledger against the already-dropped table no-ops
  // through IF EXISTS, exactly like a retry after a partial prod failure.
  await client.query('DROP SCHEMA device_tokens_drop_test CASCADE');
  await apply();
  expect(
    (await client.query('SELECT count(*)::integer AS count FROM public.device_tokens')).rows[0]
      .count,
  ).toBe(1);
});
