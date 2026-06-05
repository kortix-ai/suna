-- Background-worker leader election lease.
--
-- The API runs as N replicas on ECS Fargate, but the singleton background loops
-- (cron trigger scheduler, project maintenance, warm-pool reconcile, legacy-
-- migration worker, snapshot pre-build, grant-expiry sweep) must run on exactly
-- one replica. A single TTL lease row coordinates that: one atomic UPSERT both
-- acquires (row absent / lease expired) and renews (caller already owns it).
-- See apps/api/src/shared/leader-election.ts. The app self-creates this table at
-- boot too (CREATE TABLE IF NOT EXISTS) so coordination works even where the
-- schema is managed externally. Idempotent so ensureSchema can re-run it.
CREATE TABLE IF NOT EXISTS kortix.worker_leader_lease (
  lock_key   text PRIMARY KEY,
  owner_id   text        NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
