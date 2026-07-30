-- Migration: drop_acp_session_envelopes
--
-- Remove the retired ACP envelope store after all ACP routes and runtime
-- consumers have been removed.
--
-- mixed-version-safe: OpenCode REST never reads or writes this table. An old
-- ACP pod can fail an ACP request during rollout without affecting REST
-- sessions.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS "kortix"."acp_session_envelopes" CASCADE;

-- Down Migration
-- Forward-only: retired runtime storage is intentionally not recreated.
