-- Migration: chat_identity_mfa_verified
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- ADD COLUMN, nullable, no default: a catalog-only change, no table rewrite.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- When the Kortix session that linked a Slack or Teams identity had passed a
-- second factor (Supabase `aal2`). An account that requires MFA denied every
-- chat action before this column existed, because a chat message carries no
-- factor of its own (apps/api/src/channels/core/identity.ts). Null for links
-- made without one and for every existing link: those people link again once.
ALTER TABLE "kortix"."chat_user_identities" ADD COLUMN "mfa_verified_at" timestamp with time zone;
