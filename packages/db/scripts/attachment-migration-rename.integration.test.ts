import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { repairMigrationLedger } from './migration-ledger-repair';

const adminUrl = process.env.MIGRATION_REPAIR_ADMIN_URL;
const suite = adminUrl ? describe : describe.skip;
const sourceDir = join(import.meta.dir, '..', 'migrations');
const legacy = '20260908152048390_prompt_attachments';
const current = '20260912000000000_prompt_attachments';
const prior = '20260907000000000_fixture_prior';
const prerequisites = [
  '20260909083000000_drop_dead_audit_events_index.concurrent.ts',
  '20260910164412042_drop_dead_audit_events_index_snapshot.sql',
];
const attachmentId = '11111111-1111-4111-8111-111111111111';

async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try {
    await run(context);
  } finally {
    await context.client.end();
    await context.admin.query(`drop database "${context.databaseName}" with (force)`);
    await context.admin.end();
    rmSync(context.directory, { recursive: true, force: true });
    rmSync(context.artifacts, { recursive: true, force: true });
  }
}

async function setup() {
  if (!adminUrl) throw new Error('MIGRATION_REPAIR_ADMIN_URL is required');
  const address = new URL(adminUrl);
  if (!['127.0.0.1', 'localhost'].includes(address.hostname) || address.port !== '16022') {
    throw new Error(
      'Attachment repair integration requires isolated slot 27 on loopback port 16022.',
    );
  }
  const databaseName = `kortix_attachment_repair_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${databaseName}"`);
  address.pathname = `/${databaseName}`;
  const databaseUrl = address.toString();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  // Only dependencies of the three real migrations are needed. The actual
  // attachment tables and ledger are created exclusively by node-pg-migrate.
  await client.query(`create schema kortix;
    create table kortix.session_lifecycle_commands (command_id uuid primary key);
    create table kortix.audit_events (id integer);
    create index idx_audit_events_account_source_phase_time on kortix.audit_events(id);`);
  const directory = mkdtempSync(join(tmpdir(), 'kortix-attachment-runner-'));
  writeFileSync(join(directory, `${prior}.sql`), 'select 1;\n');
  const artifacts = mkdtempSync(join(tmpdir(), 'kortix-attachment-artifacts-'));
  for (const file of readdirSync(sourceDir)) {
    if (file.endsWith('.sql') || file.endsWith('.concurrent.ts'))
      copyFileSync(join(sourceDir, file), join(artifacts, file));
  }
  const base = {
    databaseUrl,
    dir: directory,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'kortix_migrations',
    createMigrationsSchema: true,
    singleTransaction: true,
    logger: { info() {}, warn() {}, error: console.error },
  } as const;
  const up = () => runner({ ...base, direction: 'up', count: Number.POSITIVE_INFINITY, checkOrder: true });
  const upgradeFiles = () => {
    // This removes only the disposable fixture copy, never a source migration.
    rmSync(join(directory, `${legacy}.sql`), { force: true });
    for (const file of [...prerequisites, `${current}.sql`])
      copyFileSync(join(sourceDir, file), join(directory, file));
  };
  const applyLegacy = async () => {
    copyFileSync(join(sourceDir, `${current}.sql`), join(directory, `${legacy}.sql`));
    await up();
    await client.query(
      `insert into kortix.prompt_attachments
      (attachment_id, account_id, project_id, user_id, object_path, filename, mime, size_bytes, status, expires_at)
      values ($1, $1, $1, $1, 'retained/object', 'retained.txt', 'text/plain', 7, 'ready', '2099-01-01');`,
      [attachmentId],
    );
    await client.query('insert into kortix.session_lifecycle_commands values ($1)', [attachmentId]);
    await client.query('insert into kortix.prompt_attachment_references values ($1, $1, now())', [
      attachmentId,
    ]);
    upgradeFiles();
  };
  const applied: string[] = [];
  const repair = () =>
    repairMigrationLedger({
      databaseUrl,
      migrationsDir: artifacts,
      applyConnectorMigration: async () => {
        throw new Error('Unrelated connector repair requested');
      },
      applyAttachmentPrerequisite: async (name) => {
        applied.push(name);
        await runner({ ...base, direction: 'up', count: 1, checkOrder: false, file: name });
      },
    });
  const ledger = async () =>
    (
      await client.query<{ name: string }>(
        'select name from kortix_migrations.pgmigrations order by run_on, id',
      )
    ).rows.map(({ name }) => name);
  const retained = async () => {
    expect(
      (
        await client.query(
          'select attachment_id, filename, object_path, status from kortix.prompt_attachments',
        )
      ).rows,
    ).toEqual([
      {
        attachment_id: attachmentId,
        filename: 'retained.txt',
        object_path: 'retained/object',
        status: 'ready',
      },
    ]);
    expect(
      (
        await client.query(
          'select command_id, attachment_id from kortix.prompt_attachment_references',
        )
      ).rows,
    ).toEqual([{ command_id: attachmentId, attachment_id: attachmentId }]);
  };
  return {
    admin,
    client,
    databaseName,
    directory,
    artifacts,
    up,
    upgradeFiles,
    applyLegacy,
    repair,
    ledger,
    retained,
    applied,
  };
}

suite('byte-identical attachment migration rename through the real runner', () => {
  test('fresh DB applies the two prerequisites and attachment once in strict order', () =>
    fixture(async (f) => {
      f.upgradeFiles();
      expect(await f.repair()).toBe(false);
      expect((await f.up()).map(({ name }) => name)).toEqual([
        prior,
        ...prerequisites.map((name) => name.replace(/\.(ts|sql)$/, '')),
        current,
      ]);
      expect(await f.up()).toEqual([]);
      expect(
        (await f.client.query("select to_regclass('kortix.prompt_attachments') as name")).rows[0]
          .name,
      ).toBe('kortix.prompt_attachments');
    }));

  test('old applied-name DB executes missing prerequisites and preserves attachments and references', () =>
    fixture(async (f) => {
      await f.applyLegacy();
      const unrelated = await f.client.query(
        'select * from kortix_migrations.pgmigrations where name = $1',
        [prior],
      );
      await expect(f.up()).rejects.toThrow('Not run migration');
      expect(await f.repair()).toBe(true);
      expect(f.applied).toEqual(prerequisites.map((name) => name.replace(/\.(ts|sql)$/, '')));
      expect(await f.ledger()).toEqual([prior, ...f.applied, current]);
      expect(
        (
          await f.client.query('select * from kortix_migrations.pgmigrations where name = $1', [
            prior,
          ])
        ).rows,
      ).toEqual(unrelated.rows);
      expect(await f.up()).toEqual([]);
      await f.retained();
    }));

  test('already-repaired DB does not rename, reapply, or change retained rows', () =>
    fixture(async (f) => {
      await f.applyLegacy();
      await f.repair();
      const rows = await f.client.query('select * from kortix_migrations.pgmigrations order by id');
      f.applied.length = 0;
      expect(await f.repair()).toBe(false);
      expect(await f.up()).toEqual([]);
      expect(f.applied).toEqual([]);
      expect(
        (await f.client.query('select * from kortix_migrations.pgmigrations order by id')).rows,
      ).toEqual(rows.rows);
      await f.retained();
    }));

  test('duplicate-name corruption is refused before any migration or row mutation', () =>
    fixture(async (f) => {
      await f.applyLegacy();
      await f.client.query(
        'insert into kortix_migrations.pgmigrations(name, run_on) values ($1, now())',
        [current],
      );
      const before = await f.ledger();
      await expect(f.repair()).rejects.toThrow('contains both');
      expect(await f.ledger()).toEqual(before);
      expect(f.applied).toEqual([]);
      await f.retained();
    }));

  for (const filename of [`${current}.sql`, ...prerequisites]) {
    test(`checksum drift refuses ${filename} before any mutation`, () =>
      fixture(async (f) => {
        await f.applyLegacy();
        const path = join(f.artifacts, filename);
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n-- changed fixture copy\n`);
        await expect(f.repair()).rejects.toThrow('checksum mismatch');
        expect(await f.ledger()).toEqual([prior, legacy]);
        expect(f.applied).toEqual([]);
        await f.retained();
      }));
  }
});
