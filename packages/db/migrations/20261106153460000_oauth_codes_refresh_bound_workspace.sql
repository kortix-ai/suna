-- Migration: oauth_codes_refresh_bound_workspace
--
-- Workspaces auth (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C4a). The consent's workspace rides from the authorization code to the
-- access token, and from a refresh token to every access token it mints, so a
-- refresh never unbinds a token. NULL = unbound, as every row before.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE on each table for a moment; both are written only by the
-- OAuth token endpoint. 3s lock_timeout: on 55P03 the file rolls back as a
-- whole: find the holder in pg_stat_activity, rerun the migrate job. Never
-- raise the timeout. IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names the column; a code or a
-- refresh token an old pod writes is unbound, as before.
--
-- ROLL BACK: no down migration (repo policy). The columns can stay.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "bound_workspace_id" uuid;
ALTER TABLE "kortix"."oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "bound_workspace_id" uuid;
