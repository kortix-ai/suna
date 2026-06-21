-- External prerequisites the baseline assumes, for EPHEMERAL TEST/CI databases
-- on vanilla Postgres. In real environments these are provided by the platform
-- (Supabase Auth + Storage + Basejump). This is NOT a migration — it only
-- creates the minimal stubs needed for the baseline's FKs/policies to apply.
--
--   psql "$DATABASE_URL" -f scripts/test-prereqs.sql
--
-- Then: pnpm migrate   (the storage migration self-skips when storage is absent).

-- Supabase roles
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN;          END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN;  END IF; END $$;

-- Supabase Auth stubs (signatures only — these don't need to be functional to
-- create the schema; FKs/policies just need them to resolve).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;

-- Basejump accounts stub
CREATE SCHEMA IF NOT EXISTS basejump;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE n.nspname='basejump' AND t.typname='account_role') THEN
    CREATE TYPE basejump.account_role AS ENUM ('owner','member');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS basejump.account_user (
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  account_role basejump.account_role NOT NULL,
  PRIMARY KEY (user_id, account_id)
);
