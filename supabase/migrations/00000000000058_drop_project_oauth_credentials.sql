-- Remove the per-project OAuth credential store.
--
-- The provider-OAuth "connect ChatGPT/Codex + GitHub Copilot" device-code flow
-- (stored here, injected into sandboxes as OPENCODE_AUTH_CONTENT) is being
-- removed wholesale — it was unused. OAuth will return later as a `kind` in the
-- unified account-owned vault (see docs/specs/unified-iam-vault-access.md).
-- Idempotent.

DROP TABLE IF EXISTS "kortix"."project_oauth_credentials" CASCADE;
