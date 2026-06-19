-- Warm-pool presence: one row per project a user currently has OPEN. The web
-- client heartbeats while the project tab is visible and beacons a "leave" on
-- close; the warm-pool reconcile keeps spares only for present projects and
-- reaps them when presence stops. Replaces the old in-memory, per-pod presence
-- map (which the leader reconcile couldn't see across pods) and the 6h age-only
-- reap that left spares lingering long after a user left. See warm-pool.ts.
CREATE TABLE IF NOT EXISTS "kortix"."warm_pool_presence" (
  "project_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_warm_pool_presence_seen"
  ON "kortix"."warm_pool_presence" USING btree ("last_seen_at");
