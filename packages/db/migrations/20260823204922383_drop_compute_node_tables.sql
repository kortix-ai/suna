-- Migration: drop_compute_node_tables
--
-- The kortixd compute-node feature was reverted in code the same day it landed
-- (c012522493 + the emergency reverts behind #6787/#6788), but its six tables
-- stayed in the schema and its four create-migrations stayed pending for every
-- environment that had not run them yet — production among them. Promoting that
-- would have created a set of tables on prod that no code path opens: no route,
-- no service, no query references them anywhere outside packages/db (verified
-- by grep across apps/ and packages/). Dead schema on prod is not something to
-- ship and then forget; it is removed here instead, forward-only.
--
-- Net effect per environment:
--   * prod / any env that has not run the creates: create then drop within the
--     same migration run. It never serves a request with these tables present.
--   * dev / local: drops the tables and the ~500 enrollment, credential and
--     device-auth rows left over from the day the feature was live. That data is
--     unreachable — the code that read it no longer exists — and is not worth
--     keeping. DELIBERATE.
--
-- IF EXISTS on every statement so this is idempotent for an environment that
-- never received the creates.
--
-- mixed-version-safe: nothing running can miss these tables. The only build that
-- ever touched them is the reverted kortixd image, which no environment serves:
-- dev has been on post-revert images since 2026-08-23 (49842f79a and later),
-- staging and prod never received the feature at all. An old replica draining
-- during this deploy is therefore already a build with no reference to them.

set lock_timeout = '2s';
set statement_timeout = '30s';

DROP TABLE IF EXISTS "kortix"."compute_node_assignments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."compute_node_credentials" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."compute_node_device_auth_requests" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."compute_node_enrollment_tokens" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."compute_node_rpc_forwards" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."compute_nodes" CASCADE;
