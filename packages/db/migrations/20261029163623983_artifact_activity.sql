-- Migration: artifact_activity
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

CREATE TABLE "kortix"."artifact_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_session_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_events_actor_check" CHECK ("kortix"."artifact_events"."actor_user_id" is null or "kortix"."artifact_events"."actor_session_id" is null)
);
--> statement-breakpoint
CREATE TABLE "kortix"."drive_commit_authors" (
	"drive_id" uuid NOT NULL,
	"commit_id" text NOT NULL,
	"author_user_id" uuid,
	"author_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_commit_authors_drive_id_commit_id_pk" PRIMARY KEY("drive_id","commit_id"),
	CONSTRAINT "drive_commit_authors_author_check" CHECK (("kortix"."drive_commit_authors"."author_user_id" is not null) <> ("kortix"."drive_commit_authors"."author_session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_sandbox_identities" (
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_sandbox_identities_account_id_provider_external_id_pk" PRIMARY KEY("account_id","provider","external_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_events" ADD CONSTRAINT "artifact_events_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_events" ADD CONSTRAINT "artifact_events_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."drive_commit_authors" ADD CONSTRAINT "drive_commit_authors_drive_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_sandbox_identities" ADD CONSTRAINT "session_sandbox_identities_account_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_sandbox_identities" ADD CONSTRAINT "session_sandbox_identities_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_events_artifact_created" ON "kortix"."artifact_events" USING btree ("artifact_id","created_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_artifact_events_project" ON "kortix"."artifact_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_session_sandbox_identities_project" ON "kortix"."session_sandbox_identities" USING btree ("project_id");
-- Preserve provider identities before retirement drops the mutable runtime row.
-- Only canonical external_id values observed on a scope-matching session count.
-- Existing boxes use the runtime-row fallback until an identity write is observed.
CREATE FUNCTION kortix.preserve_session_sandbox_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  observed kortix.session_sandboxes%ROWTYPE;
  pass integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    observed := NEW;
  ELSE
    observed := OLD;
  END IF;
  FOR pass IN 1..2 LOOP
    IF observed.external_id IS NOT NULL AND observed.external_id <> '' THEN
      INSERT INTO kortix.session_sandbox_identities
        (account_id, provider, external_id, project_id, session_id)
      SELECT observed.account_id, observed.provider::text, observed.external_id,
             observed.project_id, observed.session_id
        FROM kortix.project_sessions s
        JOIN kortix.projects p ON p.project_id = s.project_id AND p.account_id = s.account_id
        JOIN kortix.accounts a ON a.account_id = s.account_id
       WHERE s.session_id = observed.session_id
         AND s.account_id = observed.account_id
         AND s.project_id = observed.project_id
      ON CONFLICT (account_id, provider, external_id) DO NOTHING;
    END IF;
    IF TG_OP = 'UPDATE' AND pass = 1 THEN
      observed := NEW;
    ELSE
      EXIT;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_sandboxes_preserve_identity
AFTER INSERT OR UPDATE OF external_id, provider, account_id, project_id, session_id OR DELETE
ON kortix.session_sandboxes
FOR EACH ROW EXECUTE FUNCTION kortix.preserve_session_sandbox_identity();
