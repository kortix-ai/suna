SET lock_timeout = '5s';
SET statement_timeout = '30min';

ALTER TABLE "kortix"."gateway_request_logs" ADD COLUMN "upstream_cost_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD COLUMN "final_cost_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."usage_events" ADD COLUMN "cost_usd_precise" numeric(20, 10) DEFAULT '0' NOT NULL;
