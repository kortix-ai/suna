-- Migration: account_secret_needs_reauth
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- One nullable column without a default: a catalog-only change, no table rewrite.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A ChatGPT account whose stored login stopped working (the provider rejected
-- its refresh, or the stored login cannot be read) records when that first
-- happened. The LLM gateway writes it; a successful refresh or a reconnect
-- clears it. The account stays active and in its session pools: the column is
-- a label for the person who can reconnect it, not a way to disable it.
ALTER TABLE "kortix"."account_secret_resources" ADD COLUMN "needs_reauth_at" timestamp with time zone;
