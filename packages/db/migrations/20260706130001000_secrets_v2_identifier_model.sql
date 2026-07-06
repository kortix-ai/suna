-- Up Migration
--
-- Secrets v2 — authorization centralization + the identifier model.
--
-- (1) AUTHZ CENTRALIZATION. Two secret-side gates are retired; the ONLY thing
--     deciding whether an agent gets a secret is now the agent's `secrets`
--     grant (kortix.yaml), resolved by identifier (agentMayUseEnv):
--       - `project_secrets.agent_scope` (the resource-side "which agents may
--         use this secret" allow-list) is dropped.
--       - `project_secrets.share_scope` + `project_secret_grants` (the
--         member/group "Who can access this" sharing model) are dropped. A
--         secret is now always project-wide; who MANAGES it is the human's
--         project role (member/editor), not a per-secret grant.
--     `secret_share_scope` / `secret_grant_principal` (the enum TYPES) stay —
--     `executor_connectors`/`executor_connector_grants` (connector sharing)
--     and `project_session_grants` (session visibility) still use them.
--
-- (2) IDENTIFIER MODEL. A secret becomes { identifier, name (the KEY), value }:
--       - `identifier` is unique per project — the handle an agent's `secrets`
--         grant references and the UI shows.
--       - `name` (unchanged column) is the env var KEY injected into the
--         sandbox and is no longer unique — two identifiers may share a key
--         (e.g. GMAPS-primary / GMAPS-backup, both GOOGLE_MAPS_API_KEY).
--     Existing rows get identifier = name, so every existing grant (which
--     referenced a name == key) keeps resolving to the same secret.

ALTER TABLE "kortix"."project_secrets"
  ADD COLUMN IF NOT EXISTS "identifier" varchar(128);

UPDATE "kortix"."project_secrets" SET "identifier" = "name" WHERE "identifier" IS NULL;

ALTER TABLE "kortix"."project_secrets"
  ALTER COLUMN "identifier" SET NOT NULL;

-- Replace the old (project, name) shared-row uniqueness with (project, identifier).
DROP INDEX IF EXISTS "kortix"."idx_project_secrets_project_name_shared";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_secrets_project_identifier_shared"
  ON "kortix"."project_secrets" ("project_id", "identifier")
  WHERE "owner_user_id" IS NULL;

-- Non-unique lookup index for by-KEY reads (getProjectSecretValue and friends;
-- `name` is no longer unique so these are legitimately multi-row lookups now).
CREATE INDEX IF NOT EXISTS "idx_project_secrets_project_name"
  ON "kortix"."project_secrets" ("project_id", "name");

-- Drop the resource-side agent gate (superseded entirely by the agent grant).
ALTER TABLE "kortix"."project_secrets" DROP COLUMN IF EXISTS "agent_scope";

-- Drop member/group secret sharing.
DROP TABLE IF EXISTS "kortix"."project_secret_grants";
ALTER TABLE "kortix"."project_secrets" DROP COLUMN IF EXISTS "share_scope";

-- Down Migration
--
-- Forward-only for the dropped gates (project_secret_grants rows and the
-- agent_scope/share_scope restrictions they encoded are not reconstructable).
-- The identifier column/index could in principle be dropped, but doing so
-- would silently break every agent secrets grant minted after this migration
-- — not reversed here.
