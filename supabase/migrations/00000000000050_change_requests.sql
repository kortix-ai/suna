-- Change Requests: Kortix-native PR/merge-request layer that proposes
-- merging one branch into another inside a project. The CR is metadata; the
-- underlying git operations run against whichever backend the project's repo
-- URL points to (GitHub, GitLab, Freestyle, plain git), so this works for any
-- git backend without per-host integration code.

DO $$ BEGIN
  CREATE TYPE "kortix"."change_request_status" AS ENUM (
    'open',
    'merged',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "kortix"."change_request_review_state" AS ENUM (
    'approved',
    'changes_requested',
    'commented'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."change_requests" (
  "cr_id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"        uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "project_id"        uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "number"            integer NOT NULL,
  "title"             text NOT NULL,
  "description"       text NOT NULL DEFAULT '',
  "base_ref"          text NOT NULL,
  "head_ref"          text NOT NULL,
  "status"            "kortix"."change_request_status" NOT NULL DEFAULT 'open',
  "head_commit_sha"   text,
  "base_commit_sha"   text,
  "origin_session_id" text REFERENCES "kortix"."project_sessions"("session_id") ON DELETE SET NULL,
  "created_by"        uuid NOT NULL,
  "merged_at"         timestamptz,
  "merged_by"         uuid,
  "merge_commit_sha"  text,
  "closed_at"         timestamptz,
  "closed_by"         uuid,
  "metadata"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_change_requests_account"
  ON "kortix"."change_requests" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_change_requests_project"
  ON "kortix"."change_requests" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_change_requests_project_status"
  ON "kortix"."change_requests" ("project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_change_requests_project_number"
  ON "kortix"."change_requests" ("project_id", "number");

CREATE TABLE IF NOT EXISTS "kortix"."change_request_revisions" (
  "revision_id"     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cr_id"           uuid NOT NULL REFERENCES "kortix"."change_requests"("cr_id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "head_commit_sha" text NOT NULL,
  "base_commit_sha" text NOT NULL,
  "files_changed"   integer NOT NULL DEFAULT 0,
  "additions"       integer NOT NULL DEFAULT 0,
  "deletions"       integer NOT NULL DEFAULT 0,
  "created_by"      uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_cr_revisions_cr"
  ON "kortix"."change_request_revisions" ("cr_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cr_revisions_cr_number"
  ON "kortix"."change_request_revisions" ("cr_id", "revision_number");

CREATE TABLE IF NOT EXISTS "kortix"."change_request_reviews" (
  "review_id"       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cr_id"           uuid NOT NULL REFERENCES "kortix"."change_requests"("cr_id") ON DELETE CASCADE,
  "user_id"         uuid NOT NULL,
  "state"           "kortix"."change_request_review_state" NOT NULL,
  "body"            text NOT NULL DEFAULT '',
  "revision_number" integer NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_cr_reviews_cr"
  ON "kortix"."change_request_reviews" ("cr_id");
CREATE INDEX IF NOT EXISTS "idx_cr_reviews_user"
  ON "kortix"."change_request_reviews" ("user_id");

CREATE TABLE IF NOT EXISTS "kortix"."change_request_comments" (
  "comment_id"  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cr_id"       uuid NOT NULL REFERENCES "kortix"."change_requests"("cr_id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL,
  "body"        text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_cr_comments_cr"
  ON "kortix"."change_request_comments" ("cr_id");
