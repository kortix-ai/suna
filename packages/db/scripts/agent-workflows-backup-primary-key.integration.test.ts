import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const client = new pg.Client({ connectionString: databaseUrl });
const directory = mkdtempSync(join(tmpdir(), 'backup-key-'));
const migrations = [
  '20261003052500474_agent_workflows_backup_id_index.concurrent.ts',
  '20261003052502055_agent_workflows_backup_primary_key.sql',
];
for (const name of migrations) copyFileSync(join(import.meta.dir, '../migrations', name), join(directory, name));

async function apply() {
  await runner({ databaseUrl, dir: directory, direction: 'up', migrationsSchema: 'backup_key_test', createMigrationsSchema: true, singleTransaction: true, log: () => {} });
}

async function reset() {
  await client.query('DROP TABLE IF EXISTS public.agent_workflows_backup');
  await client.query('DROP SCHEMA IF EXISTS backup_key_test CASCADE');
}

beforeAll(async () => { await client.connect(); await reset(); });
afterAll(async () => { await reset(); await client.end(); rmSync(directory, { recursive: true }); });

// The legacy relation exists only on long-lived databases, not in the baseline.
test('a fresh installation stays without a legacy backup table', async () => {
  await apply();
  const { rows } = await client.query("SELECT to_regclass('public.agent_workflows_backup') AS relation");
  expect(rows[0].relation).toBeNull();
});

test('the real migration preserves rows and removes the no_primary_key finding', async () => {
  await reset();
  await client.query('CREATE TABLE public.agent_workflows_backup (id uuid, name text)');
  await client.query("INSERT INTO public.agent_workflows_backup VALUES ('11111111-1111-4111-8111-111111111111', 'synthetic workflow')");
  await apply();
  const { rows } = await client.query(`SELECT c.conname, a.attname, i.indisvalid
    FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.agent_workflows_backup'::regclass AND c.contype = 'p'`);
  expect(rows).toEqual([{ conname: 'agent_workflows_backup_pkey', attname: 'id', indisvalid: true }]);
  expect((await client.query('SELECT name FROM public.agent_workflows_backup')).rows).toEqual([{ name: 'synthetic workflow' }]);
  await expect(client.query("INSERT INTO public.agent_workflows_backup VALUES ('11111111-1111-4111-8111-111111111111', 'duplicate')")).rejects.toMatchObject({ code: '23505' });
  await expect(client.query("INSERT INTO public.agent_workflows_backup VALUES (NULL, 'null id')")).rejects.toMatchObject({ code: '23502' });
  // Reset only the ledger: both migration guards must tolerate an existing key.
  await client.query('DROP SCHEMA backup_key_test CASCADE');
  await apply();
  expect((await client.query('SELECT count(*)::integer AS count FROM public.agent_workflows_backup')).rows[0].count).toBe(1);
});
