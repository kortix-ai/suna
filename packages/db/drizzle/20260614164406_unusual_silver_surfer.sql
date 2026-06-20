CREATE TYPE "kortix"."oauth_provider_flow_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "kortix"."oauth_provider_flows" (
	"flow_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"status" "kortix"."oauth_provider_flow_status" DEFAULT 'pending' NOT NULL,
	"verification_url" text,
	"user_code" varchar(64),
	"auth_json_enc" text,
	"error" text,
	"sharing" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."oauth_provider_flows" ADD CONSTRAINT "oauth_provider_flows_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_provider_flows_project" ON "kortix"."oauth_provider_flows" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_provider_flows_expires" ON "kortix"."oauth_provider_flows" USING btree ("expires_at");