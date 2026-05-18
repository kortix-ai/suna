CREATE TABLE IF NOT EXISTS "kortix"."project_connections" (
	"connection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"source_type" varchar(32) DEFAULT 'static' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."project_connection_tools" (
	"tool_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(192) NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb,
	"implementation" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('kortix.accounts') IS NOT NULL THEN
  ALTER TABLE "kortix"."project_connections" ADD CONSTRAINT "project_connections_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
 END IF;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('kortix.projects') IS NOT NULL THEN
  ALTER TABLE "kortix"."project_connections" ADD CONSTRAINT "project_connections_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
 END IF;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kortix"."project_connection_tools" ADD CONSTRAINT "project_connection_tools_connection_id_project_connections_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "kortix"."project_connections"("connection_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('kortix.accounts') IS NOT NULL THEN
  ALTER TABLE "kortix"."project_connection_tools" ADD CONSTRAINT "project_connection_tools_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
 END IF;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('kortix.projects') IS NOT NULL THEN
  ALTER TABLE "kortix"."project_connection_tools" ADD CONSTRAINT "project_connection_tools_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
 END IF;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_connections_account" ON "kortix"."project_connections" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_connections_project" ON "kortix"."project_connections" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_connections_project_name" ON "kortix"."project_connections" USING btree ("project_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_connection_tools_connection" ON "kortix"."project_connection_tools" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_connection_tools_project" ON "kortix"."project_connection_tools" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_connection_tools_project_name" ON "kortix"."project_connection_tools" USING btree ("project_id","name");
