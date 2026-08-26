-- Migration: account_branding
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Organization branding (enterprise `branding` entitlement): the Storage URLs
-- of the logo / icon / favicon (light + optional dark) that replace the Kortix
-- marks for the account's members. `{}` = default Kortix branding.
--
-- NOT NULL with a constant DEFAULT on an existing table is a catalog-only
-- change on PostgreSQL >= 11 (no table rewrite, no backfill): every existing
-- row reads the default from pg_attribute.attmissingval.
ALTER TABLE "kortix"."accounts" ADD COLUMN "branding" jsonb DEFAULT '{}'::jsonb NOT NULL;
