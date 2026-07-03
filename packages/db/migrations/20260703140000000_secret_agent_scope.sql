-- Up Migration
--
-- Secret → agent access control, and retirement of the "only me" override.
--
-- (1) A shared project secret gains an `agent_scope` text[] column:
--       NULL / empty  = usable by ALL agents (project-wide — the default)
--       ['a','b', …]  = usable ONLY by those agents' sessions (agent NAMES)
--     The executor applies this as an ADDITIVE filter at sandbox boot: a secret
--     whose scope excludes the running agent is dropped from that session's env.
--     So it can only ever NARROW a project-wide secret to specific agents — it
--     never widens access, and legacy rows (NULL) keep reaching every agent.
--
-- (2) The per-member "only me" personal override is retired. Every remaining
--     personal row (owner_user_id NOT NULL) is either promoted to the shared
--     project value (one winner per project+name — most-recently-updated — when
--     no shared row exists yet) or dropped (it merely shadowed an existing
--     shared row, or lost the promotion tie). Secrets are now project-scoped and
--     agent-gated; a member no longer keeps a private per-key value.

ALTER TABLE "kortix"."project_secrets"
  ADD COLUMN IF NOT EXISTS "agent_scope" text[];

-- Promote a personal override to the shared row where NO shared row of that name
-- exists yet (most-recently-updated wins; ties broken by secret_id).
WITH ranked AS (
  SELECT
    p."secret_id",
    row_number() OVER (
      PARTITION BY p."project_id", p."name"
      ORDER BY p."updated_at" DESC, p."secret_id"
    ) AS rn
  FROM "kortix"."project_secrets" p
  WHERE p."owner_user_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "kortix"."project_secrets" s
      WHERE s."project_id" = p."project_id"
        AND s."name" = p."name"
        AND s."owner_user_id" IS NULL
    )
)
UPDATE "kortix"."project_secrets" t
SET "owner_user_id" = NULL, "share_scope" = 'project', "active" = true
FROM ranked r
WHERE t."secret_id" = r."secret_id" AND r."rn" = 1;

-- Drop every remaining personal override (promotion losers + overrides that only
-- shadowed an existing shared row). "Only me" no longer exists.
DELETE FROM "kortix"."project_secrets" WHERE "owner_user_id" IS NOT NULL;

-- Down Migration
--
-- Only the schema change is reversible — the dropped personal override rows are
-- gone for good (a down can't reconstruct deleted plaintext-encrypted values).
ALTER TABLE "kortix"."project_secrets" DROP COLUMN IF EXISTS "agent_scope";
