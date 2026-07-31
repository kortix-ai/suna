SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "correlation_id" text;
