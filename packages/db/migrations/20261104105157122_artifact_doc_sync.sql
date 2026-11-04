-- Migration: artifact_doc_sync
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

CREATE TABLE "kortix"."artifact_doc_state" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"flushed_seq" bigint DEFAULT 0 NOT NULL,
	"flushed_version" text,
	"flushed_markdown" text NOT NULL,
	"lease_holder" text,
	"lease_user_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_doc_state_seq_check" CHECK ("kortix"."artifact_doc_state"."flushed_seq" >= 0 and "kortix"."artifact_doc_state"."flushed_seq" < "kortix"."artifact_doc_state"."next_seq"),
	CONSTRAINT "artifact_doc_state_lease_holder_check" CHECK ("kortix"."artifact_doc_state"."lease_holder" is null or char_length("kortix"."artifact_doc_state"."lease_holder") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_doc_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."artifact_doc_updates" (
	"artifact_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_doc_updates_artifact_id_seq_pk" PRIMARY KEY("artifact_id","seq")
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_doc_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_doc_state" ADD CONSTRAINT "artifact_doc_state_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_doc_updates" ADD CONSTRAINT "artifact_doc_updates_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;