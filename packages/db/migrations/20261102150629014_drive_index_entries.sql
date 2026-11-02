-- Migration: drive_index_entries
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
--
-- Reviewed: one new, empty table (the search index of a project's Files,
-- apps/api/src/drives/search-index/) and two nullable columns on
-- kortix.drives (no default, no rewrite: a catalog-only change under a brief
-- lock). No backfill: the indexer fills the table from the volumes. The
-- indexes are on the new, empty table, so plain CREATE INDEX blocks nothing.
-- The FK validation lock on kortix.drives scans no rows. RLS on with no
-- policy, and the client roles revoked: only the API's privileged
-- connection reads it. No pg_trgm: creating an extension needs a privilege
-- the migrate role does not have in every environment; name search is a
-- substring scan inside one drive (the primary key's drive_id prefix).

CREATE TABLE "kortix"."drive_index_entries" (
	"drive_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime" timestamp with time zone,
	"content_hash" text,
	"name" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, regexp_replace(name, '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('simple'::regconfig, regexp_replace(path, '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('simple'::regconfig, regexp_replace(body, '[^[:alnum:]]+', ' ', 'g')), 'D')) STORED,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_index_entries_drive_id_path_pk" PRIMARY KEY("drive_id","path"),
	CONSTRAINT "drive_index_entries_kind" CHECK ("kortix"."drive_index_entries"."kind" in ('file', 'dir'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."drive_index_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD COLUMN "index_head" text;--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD COLUMN "index_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."drive_index_entries" ADD CONSTRAINT "drive_index_entries_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_drive_index_entries_search" ON "kortix"."drive_index_entries" USING gin ("search");--> statement-breakpoint
CREATE INDEX "idx_drive_index_entries_path_prefix" ON "kortix"."drive_index_entries" USING btree ("drive_id","path" text_pattern_ops);--> statement-breakpoint
REVOKE ALL ON kortix.drive_index_entries FROM anon, authenticated;
