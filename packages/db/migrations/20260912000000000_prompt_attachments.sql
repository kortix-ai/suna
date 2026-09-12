-- Migration: prompt_attachments
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

CREATE TABLE "kortix"."prompt_attachment_references" (
	"command_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_attachment_references_command_id_attachment_id_pk" PRIMARY KEY("command_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."prompt_attachments" (
	"attachment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_path" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"received_bytes" integer DEFAULT 0 NOT NULL,
	"chunk_digests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sha256" text,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"finalize_token" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_attachments_object_path_unique" UNIQUE("object_path"),
	CONSTRAINT "prompt_attachments_status_check" CHECK ("kortix"."prompt_attachments"."status" IN ('uploading', 'finalizing', 'ready', 'deleting')),
	CONSTRAINT "prompt_attachments_size_check" CHECK ("kortix"."prompt_attachments"."size_bytes" > 0 AND "kortix"."prompt_attachments"."size_bytes" <= 52428800),
	CONSTRAINT "prompt_attachments_received_check" CHECK ("kortix"."prompt_attachments"."received_bytes" >= 0 AND "kortix"."prompt_attachments"."received_bytes" <= "kortix"."prompt_attachments"."size_bytes")
);
--> statement-breakpoint
ALTER TABLE "kortix"."prompt_attachment_references" ADD CONSTRAINT "prompt_attachment_refs_command_fk" FOREIGN KEY ("command_id") REFERENCES "kortix"."session_lifecycle_commands"("command_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."prompt_attachment_references" ADD CONSTRAINT "prompt_attachment_refs_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "kortix"."prompt_attachments"("attachment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prompt_attachment_references_attachment" ON "kortix"."prompt_attachment_references" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "idx_prompt_attachments_scope" ON "kortix"."prompt_attachments" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_prompt_attachments_expiry" ON "kortix"."prompt_attachments" USING btree ("expires_at");

-- API-owned metadata contains private object paths. Browser roles cannot read
-- or write either table, even if a later blanket grant adds table privileges.
REVOKE ALL ON TABLE "kortix"."prompt_attachments", "kortix"."prompt_attachment_references" FROM anon, authenticated;
ALTER TABLE "kortix"."prompt_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kortix"."prompt_attachment_references" ENABLE ROW LEVEL SECURITY;
