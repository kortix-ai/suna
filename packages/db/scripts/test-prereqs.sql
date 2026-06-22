-- External prerequisites the baseline assumes. In deployed environments these
-- come from the platform (Supabase Auth + Storage + Basejump). This is NOT a
-- migration — it only creates the minimal objects the baseline's FKs/policies
-- need, and is fully idempotent + NON-CLOBBERING + permission-safe, so it is
-- safe on both:
--   • vanilla Postgres (ephemeral test/CI DBs) — creates everything, and
--   • a fresh Supabase-local (dev worktrees) — keeps the platform's real
--     roles/auth/storage untouched and only adds Basejump, which Supabase does
--     not ship (it used to be created by the retired supabase/migrations).
--
--   psql "$DATABASE_URL" -f scripts/test-prereqs.sql
--
-- Then: pnpm migrate   (the storage migration self-skips when storage is absent).

-- Supabase roles
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN;          END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN;  END IF; END $$;

-- Supabase Auth stubs (signatures only — FKs/policies just need them to resolve).
-- Wrapped so it is NON-CLOBBERING + permission-safe: on a real Supabase DB the
-- connecting role usually can't write into the platform-owned `auth` schema
-- (insufficient_privilege is caught → real schema used as-is), and the function
-- guards mean a real auth.uid()/auth.role() is never overwritten.
DO $prereq$ BEGIN
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='auth' AND p.proname='uid') THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='auth' AND p.proname='role') THEN
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULL::text';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[test-prereqs] auth is platform-owned (Supabase) — using it as-is, stubs skipped';
END $prereq$;

-- Basejump accounts stub (same treatment — Supabase doesn't ship basejump, so on
-- a fresh Supabase-local this is what actually creates it).
DO $prereq$ BEGIN
  CREATE SCHEMA IF NOT EXISTS basejump;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE n.nspname='basejump' AND t.typname='account_role') THEN
    CREATE TYPE basejump.account_role AS ENUM ('owner','member');
  END IF;
  CREATE TABLE IF NOT EXISTS basejump.account_user (
    user_id uuid NOT NULL,
    account_id uuid NOT NULL,
    account_role basejump.account_role NOT NULL,
    PRIMARY KEY (user_id, account_id)
  );
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[test-prereqs] basejump is platform-owned — using it as-is, stubs skipped';
END $prereq$;
