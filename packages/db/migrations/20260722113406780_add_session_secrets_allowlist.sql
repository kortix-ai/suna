-- Migration: add_session_secrets_allowlist
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Backend-only per-session secrets allowlist (Kortix-as-a-Backend): a jsonb
-- array of project-secret IDENTIFIERS this session may receive. Set once by a
-- backend-origin caller at create, immutable afterward; the injected sandbox
-- env is NARROWED to (agent-grant set) INTERSECT (this allowlist) at both boot
-- and hot-push. See apps/api/src/projects/secrets.ts (intersectSecretGrants).
--
-- Purely additive:
--   [x] Nullable jsonb, no default -- metadata-only ADD COLUMN, no table
--       rewrite, no backfill. null = no restriction (pre-KaaB behavior).
--   [x] No CHECK/FK/unique/index -- read only by the session PK lookup.

ALTER TABLE "kortix"."project_sessions"
  ADD COLUMN "secrets_allowlist" jsonb;
