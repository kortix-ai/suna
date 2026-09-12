-- Migration: repo_snapshots
--
-- Config Provider v1. Adds the durable ledger for immutable repository source
-- snapshots published to S3, and the desired-revision table the publisher and
-- session-create path read.
--
--   kortix.repo_snapshots       one row per (provider, repository_id,
--                               commit_sha, format). Queued -> building ->
--                               ready | failed, driven by the leader-elected
--                               snapshot worker with an ownership-checked
--                               lease (same shape as kortix.app_deployments).
--   kortix.repo_snapshot_refs   the latest SHA the control plane has OBSERVED
--                               for one ref. Kept separate so a slow build of
--                               an older commit can never replace a newer
--                               desired revision.
--
-- NOT the same thing as kortix.project_snapshot_builds, which is the
-- per-project SANDBOX IMAGE build. "repo snapshot" = the Git source archive.
--
-- Purely additive: two NEW tables plus their indexes. Nothing existing is
-- altered, renamed, dropped or backfilled, so no mixed-version annotation
-- applies and old API code keeps running unchanged (it simply never reads
-- these tables). CREATE INDEX is safe without CONCURRENTLY here because both
-- tables are created empty in this same migration -- there are no rows to scan
-- and no concurrent writer to block.
--
-- backfill-safe: creates empty tables only. No data statement of any kind.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE "kortix"."repo_snapshot_refs" (
	"provider" varchar(16) DEFAULT 'github' NOT NULL,
	"repository_id" text NOT NULL,
	"ref" text NOT NULL,
	"desired_sha" varchar(40),
	"revision" bigint DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_via" varchar(16) DEFAULT 'reconcile' NOT NULL,
	"reconcile_after" timestamp with time zone,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_snapshot_refs_pkey" PRIMARY KEY("provider","repository_id","ref"),
	CONSTRAINT "repo_snapshot_refs_sha_check" CHECK ("kortix"."repo_snapshot_refs"."desired_sha" IS NULL OR "kortix"."repo_snapshot_refs"."desired_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "kortix"."repo_snapshots" (
	"snapshot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(16) DEFAULT 'github' NOT NULL,
	"repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"format" text NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"manifest_key" text,
	"payload_key" text,
	"archive_sha256" varchar(64),
	"compression" varchar(8),
	"tree_sha" varchar(40),
	"compressed_bytes" bigint,
	"expanded_bytes" bigint,
	"entry_count" integer,
	"producer_version" text,
	"source_project_id" uuid,
	"source_ref" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"error" text,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_snapshots_identity_key" UNIQUE("provider","repository_id","commit_sha","format"),
	CONSTRAINT "repo_snapshots_status_check" CHECK ("kortix"."repo_snapshots"."status" IN ('queued', 'building', 'ready', 'failed')),
	CONSTRAINT "repo_snapshots_sha_check" CHECK ("kortix"."repo_snapshots"."commit_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX "repo_snapshot_refs_reconcile_idx" ON "kortix"."repo_snapshot_refs" USING btree ("reconcile_after");--> statement-breakpoint
CREATE INDEX "repo_snapshots_claim_idx" ON "kortix"."repo_snapshots" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "repo_snapshots_repo_idx" ON "kortix"."repo_snapshots" USING btree ("repository_id","ready_at");