-- Up Migration
--
-- SSO auto-provision groups (opt-in per provider). When enabled, a SAML login
-- auto-creates an IAM group + claim->group mapping for every group the IdP
-- sends, so admins don't hand-map each one — they just attach project roles to
-- the auto-created groups. Adds the provider flag plus an 'sso' value to the
-- account_group_source enum (distinct from 'manual' / 'scim') so these groups
-- are identifiable in the UI. Additive + backward-compatible (default false;
-- existing providers keep the manual-mapping behavior).
--
-- ADD VALUE (not used in this migration) is transaction-safe on PG 12+.

ALTER TYPE "kortix"."account_group_source" ADD VALUE IF NOT EXISTS 'sso';

ALTER TABLE "kortix"."account_sso_providers"
  ADD COLUMN IF NOT EXISTS "auto_provision_groups" boolean NOT NULL DEFAULT false;
