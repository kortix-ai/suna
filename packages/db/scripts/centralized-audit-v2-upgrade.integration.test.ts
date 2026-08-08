import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';

const databaseUrl = process.env.AUDIT_V2_DATABASE_URL;
const migrationsDir = join(import.meta.dir, '..', 'migrations');
const bootstrapPath = join(import.meta.dir, '..', 'drizzle', '0000_bootstrap.sql');

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function applyBootstrap(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb
    );
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.role', true), '')
      $$;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean DEFAULT false NOT NULL,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text NOT NULL,
      name text NOT NULL
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$
        SELECT string_to_array(name, '/')
      $$;
  `);
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  for (const chunk of bootstrap.split('--> statement-breakpoint')) {
    const statement = chunk.trim();
    // A vanilla PostgreSQL image does not ship pg_net. Supabase pins pg_cron to
    // its main `postgres` database. The audit upgrade does not use either
    // extension, so the temporary upgrade database skips both platform pieces.
    if (/create extension if not exists (pg_net|pg_cron)/i.test(statement)) continue;
    if (statement) await client.query(statement);
  }
}

function migrationOptions(url: string, directory: string) {
  return {
    databaseUrl: url,
    dir: directory,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'kortix_migrations',
    createMigrationsSchema: true,
    checkOrder: true,
    singleTransaction: true,
    verbose: false,
    logger: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as const;
}

describe.skipIf(!databaseUrl)('centralized audit v2 — upgrade from the v1 ledger', () => {
  test(
    'backfills legacy session cursors and begins the integrity chain after legacy history',
    async () => {
      const databaseName = `audit_v2_upgrade_${randomUUID().replaceAll('-', '')}`;
      const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
      } finally {
        await admin.end();
      }

      const upgradeUrl = databaseConnectionUrl(databaseUrl!, databaseName);
      try {
        const client = new pg.Client({ connectionString: upgradeUrl });
        await client.connect();
        try {
          await applyBootstrap(client);
        } finally {
          await client.end();
        }

        expect(
          readFileSync(
            join(runtimeMigrations.path, '20260807221200000_centralized_audit_v2.sql'),
            'utf8',
          ),
        ).toContain("SET statement_timeout = '30min';");
        const migrationFiles = readdirSync(runtimeMigrations.path)
          .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
          .sort();
        const auditV2Index = migrationFiles.findIndex((name) =>
          name.startsWith('20260807221200000_centralized_audit_v2'),
        );
        expect(auditV2Index).toBeGreaterThan(0);
        await runner({
          ...migrationOptions(upgradeUrl, runtimeMigrations.path),
          direction: 'up',
          count: auditV2Index,
        });

        const legacy = new pg.Client({ connectionString: upgradeUrl });
        await legacy.connect();
        try {
          await legacy.query(
            `INSERT INTO kortix.accounts(account_id, name)
             VALUES ('d7100000-0000-4000-a000-000000000001', 'audit-v2-upgrade')`,
          );
          await legacy.query(`
            INSERT INTO kortix.audit_events(
              event_id, account_id, action, resource_type, project_id, session_id,
              actor_type, source, outcome, occurred_at
            ) VALUES
              ('d8100000-0000-4000-a000-000000000002',
               'd7100000-0000-4000-a000-000000000001', 'legacy.second', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'human', 'api', 'success', '2026-08-07T12:00:00Z'),
              ('d8100000-0000-4000-a000-000000000001',
               'd7100000-0000-4000-a000-000000000001', 'legacy.first', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'human', 'api', 'success', '2026-08-07T11:00:00Z')
          `);
        } finally {
          await legacy.end();
        }

        await runner({
          ...migrationOptions(upgradeUrl, runtimeMigrations.path),
          direction: 'up',
          count: Number.POSITIVE_INFINITY,
        });

        const verified = new pg.Client({ connectionString: upgradeUrl });
        await verified.connect();
        try {
          const backfilled = await verified.query<{
            action: string;
            session_sequence: string;
            integrity_hash: string | null;
          }>(`
            SELECT action, session_sequence, integrity_hash
            FROM kortix.audit_events
            WHERE session_id = 'legacy-session'
            ORDER BY session_sequence
          `);
          expect(backfilled.rows).toEqual([
            { action: 'legacy.first', session_sequence: '1', integrity_hash: null },
            { action: 'legacy.second', session_sequence: '2', integrity_hash: null },
          ]);

          const firstV2 = await verified.query<{
            session_sequence: string;
            integrity_previous_hash: string | null;
            integrity_hash: string;
          }>(`
            INSERT INTO kortix.audit_events(
              account_id, action, resource_type, project_id, session_id,
              actor_type, authoritative_source, outcome
            ) VALUES (
              'd7100000-0000-4000-a000-000000000001', 'v2.first', 'test',
              'd7200000-0000-4000-a000-000000000001', 'legacy-session',
              'system', 'system', 'success'
            )
            RETURNING session_sequence, integrity_previous_hash, integrity_hash
          `);
          expect(firstV2.rows[0]?.session_sequence).toBe('3');
          expect(firstV2.rows[0]?.integrity_previous_hash).toBeNull();
          expect(firstV2.rows[0]?.integrity_hash).toHaveLength(64);

          const secondV2 = await verified.query<{
            session_sequence: string;
            integrity_previous_hash: string | null;
          }>(`
            INSERT INTO kortix.audit_events(
              account_id, action, resource_type, project_id, session_id,
              actor_type, authoritative_source, outcome
            ) VALUES (
              'd7100000-0000-4000-a000-000000000001', 'v2.second', 'test',
              'd7200000-0000-4000-a000-000000000001', 'legacy-session',
              'system', 'system', 'success'
            )
            RETURNING session_sequence, integrity_previous_hash
          `);
          expect(secondV2.rows[0]).toEqual({
            session_sequence: '4',
            integrity_previous_hash: firstV2.rows[0]?.integrity_hash,
          });
        } finally {
          await verified.end();
        }
      } finally {
        runtimeMigrations.cleanup();
        const cleanup = new pg.Client({ connectionString: databaseUrl });
        await cleanup.connect();
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
      }
    },
    120_000,
  );
});
