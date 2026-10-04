-- Migration: impersonation_grants_lock_down
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Take kortix.impersonation_grants OUT of the schema-wide default grants.
--
-- The `kortix` schema carries standing default privileges from the baseline
-- (`ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT, INSERT, UPDATE ON
-- TABLES TO authenticated` / `GRANT SELECT ... TO anon`), and the schema is in
-- PostgREST's exposed list. So the table created one migration earlier was born
-- readable by `anon` and writable by any logged-in user through
-- `/rest/v1/impersonation_grants` with `Content-Profile: kortix` -- verified on
-- the live local database, where a brand-new user's UPDATE returned 204.
--
-- For an ordinary data table that is the schema's (separate, pre-existing)
-- problem. For THIS table it is a direct contradiction of what the feature
-- promises, because the row IS the capability: `expires_at` and `revoked_at`
-- are re-read from it on every impersonated request
-- (apps/api/src/shared/impersonation.ts). A client that can UPDATE the row can
-- push its own expiry past the one-hour ceiling and null out a revocation --
-- defeating both the time-box and the console's Exit button -- and a client
-- that can SELECT it learns which operator opened which customer, when, and the
-- free-text reason.
--
-- Nothing outside the API server ever needs this table. `postgres` and
-- `service_role` keep full access (the API connects as one of them); every
-- browser-reachable role gets nothing.
REVOKE ALL ON TABLE "kortix"."impersonation_grants" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."impersonation_grants" FROM authenticated;
--> statement-breakpoint
-- Belt and braces: if a future blanket `GRANT ... ON ALL TABLES IN SCHEMA
-- kortix` re-adds the privilege, RLS with no policy still denies every row to
-- every non-superuser, non-owner role.
--
-- Deliberately ENABLE and NOT FORCE. FORCE would apply RLS to the table OWNER
-- as well, and with no policy on the table that denies every row to the owner
-- too. The API's database role is the owner in this deployment and is a
-- superuser locally (so FORCE happened to be harmless here), but a deployment
-- whose API role is a plain owner would have had its impersonation feature
-- bricked on rollout with no local signal. The REVOKEs above are the control
-- that matters; ENABLE is the second line for roles that are neither.
ALTER TABLE "kortix"."impersonation_grants" ENABLE ROW LEVEL SECURITY;
