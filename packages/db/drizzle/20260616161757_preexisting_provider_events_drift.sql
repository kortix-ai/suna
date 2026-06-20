ALTER TYPE "kortix"."sandbox_provider" ADD VALUE 'platinum';--> statement-breakpoint
CREATE TABLE "kortix"."provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"total_ms" integer,
	"marks" jsonb DEFAULT '[]'::jsonb,
	"attempts" integer DEFAULT 1,
	"error_class" text,
	"error" text,
	"from_provider" text,
	"session_id" text,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_provider_events_provider" ON "kortix"."provider_events" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_provider_events_kind" ON "kortix"."provider_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_provider_events_outcome" ON "kortix"."provider_events" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_provider_events_created" ON "kortix"."provider_events" USING btree ("created_at");