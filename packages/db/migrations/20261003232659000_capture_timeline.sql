-- Migration: capture_timeline
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- WHAT: Kortix Capture tables and a durable job queue. Every table is NEW and
-- empty, so no statement here locks or rewrites an existing table; the FKs
-- reference kortix.projects (SHARE ROW EXCLUSIVE on it for milliseconds, no scan
-- because the new tables are empty).
--
-- HAND EDITS to the generated SQL (keep them when regenerating):
--   * timeline_frames, timeline_actions and timeline_audio are RANGE-partitioned
--     by month on "ts" (learnings 2026-10-01: bound an append-only table by
--     time). Each has a DEFAULT partition, so an INSERT whose month has no
--     partition yet still succeeds. kortix.capture_timeline_ensure_partitions
--     creates the monthly partitions with CREATE TABLE (LIKE) + ATTACH, which
--     takes SHARE UPDATE EXCLUSIVE on the parent (inserts keep flowing), the
--     same pattern as kortix.audit_events_ensure_partitions. The API calls it
--     daily for the next 3 months; this migration creates the first ones.
--   * Their primary keys include "ts" because a unique index on a partitioned
--     table must contain the partition key. No foreign key references them.
--   * Supabase Storage bucket `kortix-capture` for local dev, preview and
--     self-host (no-op where storage is absent). AWS uses a Terraform bucket.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- new tables and the function; nothing else references them.

CREATE TABLE "kortix"."capture_device_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"device_code_hash" varchar(128) NOT NULL,
	"user_code" varchar(9) NOT NULL,
	"machine_key_sha256" varchar(64) NOT NULL,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"device_id" uuid,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_device_grants_status" CHECK ("kortix"."capture_device_grants"."status" in ('pending', 'approved', 'denied', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_devices" (
	"device_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"machine_key_sha256" varchar(64) NOT NULL,
	"token_hash" varchar(128),
	"token_issued_at" timestamp with time zone,
	"name" text,
	"os" text,
	"os_version" text,
	"arch" text,
	"app_version" text,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" jsonb,
	"status_reported_at" timestamp with time zone,
	"last_credentials_at" timestamp with time zone,
	"policy_override" jsonb,
	"index_day" text,
	"index_etag" text,
	"index_lines" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."job_queue" (
	"job_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"queue" text NOT NULL,
	"job_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_queue_status" CHECK ("kortix"."job_queue"."status" in ('queued', 'done', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."range_outputs" (
	"output_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"range_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"output" jsonb,
	"usage" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "range_outputs_kind" CHECK ("kortix"."range_outputs"."kind" in ('segmentation', 'transcript', 'annotation')),
	CONSTRAINT "range_outputs_status" CHECK ("kortix"."range_outputs"."status" in ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."timeline_actions" (
	"action_id" uuid DEFAULT kortix.uuid_v7() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"chunk_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"app" text,
	"window_title" text,
	"description" text,
	"target" jsonb,
	"screenshot" text,
	CONSTRAINT "timeline_actions_pkey" PRIMARY KEY("action_id","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "kortix"."timeline_audio" (
	"line_id" uuid DEFAULT kortix.uuid_v7() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"chunk_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "timeline_audio_pkey" PRIMARY KEY("line_id","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "kortix"."timeline_chunks" (
	"chunk_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"manifest_key" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_chunks_kind" CHECK ("kortix"."timeline_chunks"."kind" in ('chunk', 'audio', 'actions'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."timeline_frames" (
	"frame_id" uuid DEFAULT kortix.uuid_v7() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"chunk_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"frame_index" integer,
	"app" text,
	"bundle_id" text,
	"title" text,
	"url" text,
	"domain" text,
	"ocr_text" text,
	"ocr_boxes" jsonb,
	"inactive" boolean DEFAULT false NOT NULL,
	CONSTRAINT "timeline_frames_pkey" PRIMARY KEY("frame_id","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "kortix"."timeline_ranges" (
	"range_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"source" text NOT NULL,
	"title" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_ranges_source" CHECK ("kortix"."timeline_ranges"."source" in ('detected', 'saved')),
	CONSTRAINT "timeline_ranges_status" CHECK ("kortix"."timeline_ranges"."status" in ('open', 'closed', 'processing', 'processed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."capture_device_grants" ADD CONSTRAINT "capture_device_grants_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_devices" ADD CONSTRAINT "capture_devices_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_policies" ADD CONSTRAINT "capture_policies_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."range_outputs" ADD CONSTRAINT "range_outputs_range_id_timeline_ranges_range_id_fk" FOREIGN KEY ("range_id") REFERENCES "kortix"."timeline_ranges"("range_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ADD CONSTRAINT "timeline_chunks_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ADD CONSTRAINT "timeline_chunks_device_id_capture_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "kortix"."capture_devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_ranges" ADD CONSTRAINT "timeline_ranges_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_ranges" ADD CONSTRAINT "timeline_ranges_device_id_capture_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "kortix"."capture_devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_device_grants_user_code" ON "kortix"."capture_device_grants" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_device_grants_device_code" ON "kortix"."capture_device_grants" USING btree ("device_code_hash");--> statement-breakpoint
CREATE INDEX "idx_capture_device_grants_expires" ON "kortix"."capture_device_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_devices_identity" ON "kortix"."capture_devices" USING btree ("project_id","machine_key_sha256","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_devices_token" ON "kortix"."capture_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_capture_devices_project_user" ON "kortix"."capture_devices" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_job_queue_key" ON "kortix"."job_queue" USING btree ("queue","job_key");--> statement-breakpoint
CREATE INDEX "idx_job_queue_due" ON "kortix"."job_queue" USING btree ("queue","run_at") WHERE "kortix"."job_queue"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_job_queue_finished" ON "kortix"."job_queue" USING btree ("updated_at") WHERE "kortix"."job_queue"."status" <> 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_range_outputs_range_kind" ON "kortix"."range_outputs" USING btree ("range_id","kind");--> statement-breakpoint
CREATE INDEX "idx_timeline_actions_project_user_ts" ON "kortix"."timeline_actions" USING btree ("project_id","user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_timeline_actions_chunk" ON "kortix"."timeline_actions" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "idx_timeline_actions_search" ON "kortix"."timeline_actions" USING gin (to_tsvector('simple'::regconfig, coalesce("kind", '') || ' ' || coalesce("app", '') || ' ' || coalesce("window_title", '') || ' ' || coalesce("description", '')));--> statement-breakpoint
CREATE INDEX "idx_timeline_audio_project_user_ts" ON "kortix"."timeline_audio" USING btree ("project_id","user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_timeline_audio_chunk" ON "kortix"."timeline_audio" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "idx_timeline_audio_search" ON "kortix"."timeline_audio" USING gin (to_tsvector('simple'::regconfig, coalesce("text", '')));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_timeline_chunks_manifest" ON "kortix"."timeline_chunks" USING btree ("manifest_key");--> statement-breakpoint
CREATE INDEX "idx_timeline_chunks_project_user_start" ON "kortix"."timeline_chunks" USING btree ("project_id","user_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_timeline_chunks_device_start" ON "kortix"."timeline_chunks" USING btree ("device_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_timeline_frames_project_user_ts" ON "kortix"."timeline_frames" USING btree ("project_id","user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_timeline_frames_chunk" ON "kortix"."timeline_frames" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "idx_timeline_frames_search" ON "kortix"."timeline_frames" USING gin (to_tsvector('simple'::regconfig, coalesce("app", '') || ' ' || coalesce("title", '') || ' ' || coalesce("url", '') || ' ' || coalesce("ocr_text", '')));--> statement-breakpoint
CREATE INDEX "idx_timeline_ranges_project_user_start" ON "kortix"."timeline_ranges" USING btree ("project_id","user_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_timeline_ranges_open" ON "kortix"."timeline_ranges" USING btree ("end_at") WHERE "kortix"."timeline_ranges"."status" = 'open';--> statement-breakpoint
CREATE TABLE "kortix"."timeline_frames_default" PARTITION OF "kortix"."timeline_frames" DEFAULT;--> statement-breakpoint
CREATE TABLE "kortix"."timeline_actions_default" PARTITION OF "kortix"."timeline_actions" DEFAULT;--> statement-breakpoint
CREATE TABLE "kortix"."timeline_audio_default" PARTITION OF "kortix"."timeline_audio" DEFAULT;--> statement-breakpoint
CREATE OR REPLACE FUNCTION kortix.capture_timeline_ensure_partitions(first_month date, months_ahead integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = kortix, public
AS $$
DECLARE
  parent text;
  month_start date;
  last_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date + make_interval(months => months_ahead);
  range_from text;
  range_to text;
  partition_name text;
  created integer := 0;
BEGIN
  -- Two replicas can run the daily tick at once; serialise them.
  PERFORM pg_advisory_xact_lock(hashtextextended('kortix.capture_timeline_ensure_partitions', 0));
  FOREACH parent IN ARRAY ARRAY['timeline_frames', 'timeline_actions', 'timeline_audio'] LOOP
    month_start := date_trunc('month', first_month)::date;
    WHILE month_start <= last_month LOOP
      partition_name := parent || '_p' || to_char(month_start, 'YYYYMM');
      range_from := to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00';
      range_to := to_char((month_start + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00';
      IF to_regclass(format('kortix.%I', partition_name)) IS NULL THEN
        EXECUTE format('CREATE TABLE kortix.%I (LIKE kortix.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
          partition_name, parent);
        -- Rows that landed in the default partition for this month move first:
        -- ATTACH refuses while the default holds a row of the new range.
        EXECUTE format(
          'WITH moved AS (DELETE FROM kortix.%I WHERE ts >= %L AND ts < %L RETURNING *) INSERT INTO kortix.%I SELECT * FROM moved',
          parent || '_default', range_from, range_to, partition_name);
        EXECUTE format('ALTER TABLE kortix.%I ATTACH PARTITION kortix.%I FOR VALUES FROM (%L) TO (%L)',
          parent, partition_name, range_from, range_to);
        created := created + 1;
      END IF;
      month_start := (month_start + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN created;
END;
$$;--> statement-breakpoint
SELECT kortix.capture_timeline_ensure_partitions((now() AT TIME ZONE 'UTC')::date, 3);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'public'
  ) THEN
    RAISE NOTICE 'storage.buckets not present or unexpected shape — skipping capture bucket setup.';
    RETURN;
  END IF;
  -- Private and policy-free: the API reads and writes through the S3 protocol
  -- key pair, which bypasses storage.objects policies.
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('kortix-capture', 'kortix-capture', false)
  ON CONFLICT (id) DO UPDATE SET public = excluded.public;
END $$;
--> statement-breakpoint
-- Only the API (postgres / service_role) reads or writes these tables. Revoke
-- the client roles and turn RLS on with no policy, so a later blanket grant
-- still exposes nothing through PostgREST.
REVOKE ALL ON TABLE "kortix"."job_queue", "kortix"."capture_device_grants", "kortix"."capture_devices",
  "kortix"."capture_policies", "kortix"."timeline_chunks", "kortix"."timeline_frames", "kortix"."timeline_actions",
  "kortix"."timeline_audio", "kortix"."timeline_ranges", "kortix"."range_outputs" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "kortix"."job_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_device_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_frames" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_audio" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_ranges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."range_outputs" ENABLE ROW LEVEL SECURITY;
