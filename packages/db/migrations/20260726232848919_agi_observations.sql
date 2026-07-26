-- Migration: agi_observations
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Purely additive: one brand-new table plus its own index and constraints. No
-- existing object is dropped, renamed, or retyped, and no value is added to an
-- existing enum, so no mixed-version-safe / enum-value-checked annotation is
-- required. Old code never sees the table; the single FK only adds a referential
-- check to writes on the NEW table (projects is the referenced side). The index
-- is created inline with the table, which needs no CONCURRENTLY: the table has
-- no rows and no traffic at creation time.
--
-- The measurement time series behind spec section 4.2 (R-12b). One row is one
-- reading of one metric for one goal. Append-only: nothing updates or deletes a
-- row, which is why the table has no `updated_at` -- R-12f makes an observation
-- evidence and never authority, and a rewritable series proves nothing.
CREATE TABLE "kortix"."agi_observations" (
	"observation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agi_observations_value_finite_check" CHECK ("kortix"."agi_observations"."value" > double precision '-infinity' and "kortix"."agi_observations"."value" < double precision 'infinity'),
	CONSTRAINT "agi_observations_metric_check" CHECK ("kortix"."agi_observations"."metric" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "agi_observations_goal_slug_check" CHECK (length("kortix"."agi_observations"."goal_slug") between 1 and 128),
	CONSTRAINT "agi_observations_source_check" CHECK (length("kortix"."agi_observations"."source") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "kortix"."agi_observations" ADD CONSTRAINT "agi_observations_workspace_id_projects_project_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agi_observations_series" ON "kortix"."agi_observations" USING btree ("workspace_id","goal_slug","metric","observed_at" DESC NULLS LAST,"observation_id" DESC NULLS LAST);