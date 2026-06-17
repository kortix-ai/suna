-- Supabase-managed roles that the repo migrations GRANT to but that a vanilla
-- postgres:16-alpine image does not ship with. Without these, the very first
-- grant migration (00000000000001_table_grants.sql) fails.
--
-- These are NOPROFILE/NOLOGIN placeholders sufficient to satisfy GRANT/ALTER
-- DEFAULT PRIVILEGES. They are NOT a security model — RLS/JWT behaviour is not
-- being tested here, only that the DDL applies cleanly.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN;
  END IF;
END $$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO CURRENT_USER;
