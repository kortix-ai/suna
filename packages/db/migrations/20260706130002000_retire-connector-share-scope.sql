-- Up Migration
--
-- Centralize connector authorization on the AGENT (decided 2026-07-06,
-- docs/specs/2026-07-05-agent-first-config-unification.md). Connectors are now
-- always project-wide visible; the ONLY gate on which agents may call a
-- connector is the agent's `connectors` grant (`[[agents]].connectors` in
-- kortix.toml, enforced by iam/agent-scope.ts). This retires BOTH other
-- connector-side gates removed from the app in this same change:
--
--   1. executor_connectors.share_scope + executor_connector_grants — the
--      per-connector member/department "who can access" picker.
--   2. executor_connectors.agent_scope — the per-connector "which agents can
--      call it" picker (a DIFFERENT, now-redundant axis from the agent-side
--      grant above).
--
-- NO SILENT SURPRISE: a connector that was `restricted` to a specific
-- allow-list becomes visible to every project member (their project role
-- still gates whether they can see/manage it at all; this only widens WHO
-- can see an already-existing connector, never grants edit). A connector that
-- was agent-scoped becomes callable by every agent whose own grant already
-- lists it — never wider than that, since the agent-side grant still applies.

-- 1. Flip any restricted connectors to project-wide (the picker is gone; a
--    connector is unconditionally project-wide now).
UPDATE "kortix"."executor_connectors"
SET "share_scope" = 'project', "updated_at" = now()
WHERE "share_scope" = 'restricted';

-- 2. Drop the now-dead per-connector member/group grant rows.
DELETE FROM "kortix"."executor_connector_grants";

-- 3. Belt-and-suspenders: make `project` the only value Postgres will accept
--    for this column going forward, independent of app-layer discipline
--    (mirrors the `executor_connectors_credential_mode_shared_only` CHECK
--    added when `per_user` was retired).
ALTER TABLE "kortix"."executor_connectors"
  ADD CONSTRAINT "executor_connectors_share_scope_project_only"
  CHECK ("share_scope" = 'project');

-- 4. Neutralize agent_scope — no longer an enforcement input (nothing in the
--    app reads or writes it as of this change). Null out existing values so a
--    stale scope can never mislead anyone reading the column directly. The
--    column itself stays ORPHANED (not dropped) — same disposition as the
--    `per_user` value left in `executor_credential_mode`: Postgres can't
--    cleanly drop a column's meaning without a bigger migration, and there is
--    no live write path left to reintroduce a non-null value (the CRUD
--    function + `/agent-scope` route + kortix.toml parsing were all removed
--    from the app in this same change).
UPDATE "kortix"."executor_connectors"
SET "agent_scope" = NULL, "updated_at" = now()
WHERE "agent_scope" IS NOT NULL;

-- Down Migration
--
-- Forward-only: connector authorization is unified on the agent grant. The
-- per-connector member/department allow-list and the per-connector agent
-- scope are intentionally not restored (their data was deliberately dropped
-- above). Only the CHECK constraint is reversible.
ALTER TABLE "kortix"."executor_connectors"
  DROP CONSTRAINT IF EXISTS "executor_connectors_share_scope_project_only";
