CREATE TABLE "kortix"."project_oauth_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_id" varchar(64) NOT NULL,
	"refresh_enc" text NOT NULL,
	"access_enc" text NOT NULL,
	"expires" bigint NOT NULL,
	"oauth_account_id" varchar(255),
	"enterprise_url" varchar(255),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_oauth_credentials" ADD CONSTRAINT "project_oauth_credentials_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_oauth_creds_project" ON "kortix"."project_oauth_credentials" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_oauth_creds_project_provider" ON "kortix"."project_oauth_credentials" USING btree ("project_id","provider_id");