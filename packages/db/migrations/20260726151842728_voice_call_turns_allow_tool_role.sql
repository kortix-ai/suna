-- Migration: voice_call_turns_allow_tool_role
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand/contract checklist -- delete lines that don't apply, keep the rest honest:
--   [x] Dropping/recreating a CHECK constraint on an existing table (voice_call_turns_role_check).
--       This WIDENS the allowed set ('user','agent' -> 'user','agent','tool'); nothing
--       previously accepted becomes rejected.
-- mixed-version-safe: old API pods only ever INSERT role IN ('user','agent') and only ever
-- READ `role` as an opaque string (runtime.ts's readTurns, mcp.ts) -- neither the widened
-- CHECK nor a 'tool' row an old pod happens to read back can break it. New code (this
-- deploy's mcp.ts) starts writing role='tool' only after this migration has applied, since
-- deploy-dev.yml/deploy-prod.yml run `pnpm --filter @kortix/db migrate` before the app
-- rollout -- so the widened constraint is always live before any pod can violate it.

-- Recording each ask_kortix/run_command tool call the voice-agent worker makes (mcp.ts) as
-- its own transcript line, alongside the existing user/agent speech turns, is what makes
-- "what did the voice agent DO during this call" visible in the same feed as what was said.
--
-- Expand step 1/2: added NOT VALID so this never holds a full-table validation scan;
-- VALIDATE CONSTRAINT (cheap -- SHARE UPDATE EXCLUSIVE, doesn't block reads/writes) follows
-- in the next migration, same two-step shape as
-- 20260718164553217_add_project_model_generation_config.sql /
-- 20260718170853806_validate_project_model_generation_config_check.sql.
ALTER TABLE "kortix"."voice_call_turns"
  DROP CONSTRAINT "voice_call_turns_role_check";

ALTER TABLE "kortix"."voice_call_turns"
  ADD CONSTRAINT "voice_call_turns_role_check" CHECK ("role" IN ('user', 'agent', 'tool')) NOT VALID;
