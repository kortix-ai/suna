-- Up Migration
--
-- IAM V2 per-RESOURCE scoping (iam_resource_grants). Scopes a member or group
-- (Department) to a SPECIFIC agent or skill within a project. Sits as an
-- INTERSECTION on top of the project-role / custom-policy verdict in
-- authorizeV2: a resource (agent name / skill slug) becomes "scoped" once >=1
-- grant row exists for (project, resource_type, resource_id); UNSCOPED
-- resources stay project-wide (no behaviour change), so the feature is
-- inherently opt-in and never causes a surprise lockout. resource_id is TEXT
-- because agent names + skill slugs are file-based manifest keys, not uuids.
-- Hand-written (node-pg-migrate) because the drizzle snapshot chain forked
-- during the origin/main merge; node-pg-migrate applies migrations/*.sql
-- independently of the drizzle snapshot.

CREATE TABLE IF NOT EXISTS "kortix"."iam_resource_grants" (
  "grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "resource_type" varchar(32) NOT NULL,
  "resource_id" text NOT NULL,
  "principal_type" varchar(16) NOT NULL,
  "principal_id" uuid NOT NULL,
  "effect" varchar(8) DEFAULT 'allow' NOT NULL,
  "expires_at" timestamp with time zone,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "iam_resource_grants_account_id_accounts_account_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "iam_resource_grants_project_id_projects_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_iam_resource_grants"
  ON "kortix"."iam_resource_grants" USING btree ("project_id", "resource_type", "resource_id", "principal_type", "principal_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_iam_resource_grants_project_type"
  ON "kortix"."iam_resource_grants" USING btree ("project_id", "resource_type");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_iam_resource_grants_resource"
  ON "kortix"."iam_resource_grants" USING btree ("project_id", "resource_type", "resource_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_iam_resource_grants_principal"
  ON "kortix"."iam_resource_grants" USING btree ("principal_type", "principal_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_iam_resource_grants_account"
  ON "kortix"."iam_resource_grants" USING btree ("account_id");

-- Down Migration

DROP TABLE IF EXISTS "kortix"."iam_resource_grants";
