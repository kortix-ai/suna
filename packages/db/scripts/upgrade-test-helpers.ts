import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** Shared by the migration-upgrade integration tests: build a database at an old migration, then roll it forward. */
export const migrationsDir = join(import.meta.dir, '..', 'migrations');
const bootstrapPath = join(import.meta.dir, '..', 'drizzle', '0000_bootstrap.sql');

export function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function applyBootstrap(client: pg.Client): Promise<void> {
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

export function migrationOptions(url: string, directory: string) {
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

