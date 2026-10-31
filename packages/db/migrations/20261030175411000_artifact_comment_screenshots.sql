-- Migration: artifact_comment_screenshots
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

CREATE TABLE "kortix"."artifact_comment_screenshot_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"comment_id" uuid,
	"state" text DEFAULT 'uploading' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL,
	"locked_until" timestamp with time zone,
	"lease_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_screenshot_state_check" CHECK ("kortix"."artifact_comment_screenshot_objects"."state" in ('uploading', 'attached', 'deleting')),
	CONSTRAINT "artifact_screenshot_attempts_check" CHECK ("kortix"."artifact_comment_screenshot_objects"."attempts" >= 0),
	CONSTRAINT "artifact_screenshot_attached_check" CHECK ("kortix"."artifact_comment_screenshot_objects"."state" <> 'attached' or "kortix"."artifact_comment_screenshot_objects"."comment_id" is not null),
	CONSTRAINT "artifact_screenshot_key_check" CHECK ("kortix"."artifact_comment_screenshot_objects"."object_key" ~ ('^' || "kortix"."artifact_comment_screenshot_objects"."project_id"::text || '/artifact-comments/[0-9a-f-]{36}[.](png|webp)$'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_screenshot_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_screenshot_objects" ADD CONSTRAINT "artifact_screenshot_comment_fk" FOREIGN KEY ("comment_id") REFERENCES "kortix"."artifact_comments"("comment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_screenshot_project" ON "kortix"."artifact_comment_screenshot_objects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_screenshot_comment" ON "kortix"."artifact_comment_screenshot_objects" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_screenshot_due" ON "kortix"."artifact_comment_screenshot_objects" USING btree ("next_attempt_at") WHERE "kortix"."artifact_comment_screenshot_objects"."state" <> 'attached';
CREATE FUNCTION kortix.queue_artifact_comment_screenshot_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.screenshot_key IS NOT NULL AND
     (TG_OP = 'DELETE' OR NEW.screenshot_key IS DISTINCT FROM OLD.screenshot_key OR NEW.deleted_at IS NOT NULL) THEN
    UPDATE kortix.artifact_comment_screenshot_objects
       SET state = 'deleting',
           next_attempt_at = LEAST(next_attempt_at, clock_timestamp())
     WHERE object_key = OLD.screenshot_key;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_comment_screenshot_delete
BEFORE DELETE OR UPDATE OF screenshot_key, deleted_at ON kortix.artifact_comments
FOR EACH ROW EXECUTE FUNCTION kortix.queue_artifact_comment_screenshot_delete();
