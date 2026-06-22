CREATE TABLE "kortix"."gateway_api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_prefix" varchar(24) NOT NULL,
	"secret_key_hash" varchar(128) NOT NULL,
	"status" "kortix"."api_key_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_request_logs" (
	"log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_user_id" uuid,
	"key_id" uuid,
	"requested_model" text NOT NULL,
	"resolved_model" text NOT NULL,
	"provider" text NOT NULL,
	"status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"candidates_tried" jsonb DEFAULT '[]'::jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"upstream_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"final_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"billing_mode" text,
	"request" jsonb,
	"response" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."gateway_api_keys" ADD CONSTRAINT "gateway_api_keys_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_api_keys" ADD CONSTRAINT "gateway_api_keys_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD CONSTRAINT "gateway_request_logs_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD CONSTRAINT "gateway_request_logs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_keys_secret_hash" ON "kortix"."gateway_api_keys" USING btree ("secret_key_hash");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_project" ON "kortix"."gateway_api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_account" ON "kortix"."gateway_api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_logs_request_id" ON "kortix"."gateway_request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_account_time" ON "kortix"."gateway_request_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_project_time" ON "kortix"."gateway_request_logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_model" ON "kortix"."gateway_request_logs" USING btree ("provider","resolved_model");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_account_ok" ON "kortix"."gateway_request_logs" USING btree ("account_id","ok");