-- Repo-first project sessions issue sandbox-scoped API keys for
-- kortix.session_sandboxes rows. Keep api_keys.sandbox_id as the shared
-- UUID reference used by both legacy sandboxes and session sandboxes.

ALTER TABLE "kortix"."api_keys"
  DROP CONSTRAINT IF EXISTS "api_keys_sandbox_id_sandboxes_sandbox_id_fk";
