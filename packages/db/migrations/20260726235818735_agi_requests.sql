-- Migration: agi_requests
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Purely additive: one brand-new table plus its own indexes and constraints. No
-- existing object is dropped, renamed, or retyped, and no value is added to an
-- existing enum, so no mixed-version-safe / enum-value-checked annotation is
-- required. Old code never sees the table; both FKs only add a referential check
-- to writes on the NEW table (projects and agi_tasks are the referenced sides).
-- The indexes are created on an empty, traffic-free table, so no CONCURRENTLY.
--
-- The pending human request behind spec section 4.3 (R-12g). A session that
-- cannot proceed without a human act -- a credential, an access grant, a
-- decision -- writes one of these instead of narrating the block into its own
-- session log, which is where an unattended 07:00 push currently dies silently.
--
-- There is deliberately NO value column. The agent asks for a credential by
-- minting a fill-in link the human completes; it must never see the secret, so
-- there is nowhere here to put one. `url` holds that minted link and is
-- CHECK-constrained to http(s), so a pasted bearer token is not even storable.
CREATE TABLE "kortix"."agi_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"need" text NOT NULL,
	"why" text,
	"url" text,
	"responder_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_via" text,
	"requested_by_session_id" text,
	"origin_fingerprint" text,
	"satisfied_at" timestamp with time zone,
	"satisfied_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agi_requests_kind_check" CHECK ("kortix"."agi_requests"."kind" in ('secret', 'connector', 'access', 'decision')),
	CONSTRAINT "agi_requests_status_check" CHECK ("kortix"."agi_requests"."status" in ('pending', 'satisfied', 'cancelled')),
	CONSTRAINT "agi_requests_need_check" CHECK (length("kortix"."agi_requests"."need") between 1 and 500),
	CONSTRAINT "agi_requests_delivery_coherent_check" CHECK (("kortix"."agi_requests"."delivered_at" is null and "kortix"."agi_requests"."delivered_via" is null) or ("kortix"."agi_requests"."delivered_at" is not null and "kortix"."agi_requests"."delivered_via" is not null)),
	CONSTRAINT "agi_requests_delivery_addressed_check" CHECK ("kortix"."agi_requests"."delivered_at" is null or "kortix"."agi_requests"."responder_user_id" is not null),
	CONSTRAINT "agi_requests_satisfied_coherent_check" CHECK (("kortix"."agi_requests"."status" = 'satisfied') = ("kortix"."agi_requests"."satisfied_at" is not null)),
	CONSTRAINT "agi_requests_url_scheme_check" CHECK ("kortix"."agi_requests"."url" is null or "kortix"."agi_requests"."url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "kortix"."agi_requests" ADD CONSTRAINT "agi_requests_workspace_id_projects_project_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."agi_requests" ADD CONSTRAINT "agi_requests_task_id_agi_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "kortix"."agi_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agi_requests_task_pending" ON "kortix"."agi_requests" USING btree ("workspace_id","task_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_agi_requests_responder_pending" ON "kortix"."agi_requests" USING btree ("workspace_id","responder_user_id","created_at") WHERE status = 'pending' and responder_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agi_requests_origin_fingerprint" ON "kortix"."agi_requests" USING btree ("workspace_id","origin_fingerprint") WHERE origin_fingerprint is not null;