-- Migration: capture_enrollment
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

-- WHAT: Kortix Capture IT rollout. An enrollment token lets a computer enroll
-- itself as the person signed in to Windows (capture_enrollment_tokens); each
-- computer + person that presents one is a row in capture_enrollments, which
-- the device polls until a member is matched or an admin decides. Both tables
-- are NEW and empty. capture_devices gains a nullable column (catalog-only, no
-- rewrite); it has no FK, so no lock on capture_devices beyond the ALTER.
-- Client roles revoked and RLS on with no policy: only the API reads these.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- two tables and the column; nothing else references them.

CREATE TABLE "kortix"."capture_enrollment_tokens" (
	"token_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"token_prefix" text NOT NULL,
	"email_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_devices" integer,
	"require_approval" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_enrollments" (
	"enrollment_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"machine_key_sha256" varchar(64) NOT NULL,
	"principal" text NOT NULL,
	"principal_name" text,
	"account_name" text,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"user_id" uuid,
	"device_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_enrollments_status" CHECK ("kortix"."capture_enrollments"."status" in ('pending', 'approved', 'denied', 'enrolled'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."capture_devices" ADD COLUMN "enrollment_token_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."capture_enrollment_tokens" ADD CONSTRAINT "capture_enrollment_tokens_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_enrollments" ADD CONSTRAINT "capture_enrollments_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_enrollments" ADD CONSTRAINT "capture_enrollments_token_id_capture_enrollment_tokens_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "kortix"."capture_enrollment_tokens"("token_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_enrollment_tokens_hash" ON "kortix"."capture_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_capture_enrollment_tokens_account" ON "kortix"."capture_enrollment_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_enrollments_identity" ON "kortix"."capture_enrollments" USING btree ("account_id","machine_key_sha256","principal");--> statement-breakpoint
CREATE INDEX "idx_capture_enrollments_token" ON "kortix"."capture_enrollments" USING btree ("token_id");;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."capture_enrollment_tokens", "kortix"."capture_enrollments" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "kortix"."capture_enrollment_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_enrollments" ENABLE ROW LEVEL SECURITY;
