-- Migration: connection_policies
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Per-CONNECTION tool-call policies, keyed by profile_id.
--
-- One connector can hold several connections (support@, sales@, a member's own
-- mailbox) that warrant DIFFERENT permissions. Connector-scoped rules cannot
-- express that: they are keyed by the connector, so every connection under it
-- shares one policy.
--
-- Not folded into executor_connector_policies because sync.ts deletes every row
-- for a connector and re-inserts from the manifest on each manifest write, which
-- would destroy DB-authored rows. Not in the manifest either: a member's private
-- connection can never appear in git, and profile uuids are not portable.
--
-- Purely additive: a new table nothing reads yet, so an old app version running
-- against this schema is unaffected. The index is created non-concurrently ON
-- PURPOSE -- the table is created in this same migration, so it is empty and
-- holds no lock anything else is waiting on.

CREATE TABLE "kortix"."executor_connection_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"match" varchar(512) NOT NULL,
	"action" "kortix"."executor_policy_action" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."executor_connection_policies" ADD CONSTRAINT "executor_connection_policies_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "kortix"."executor_connection_profiles"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_executor_connection_policies_profile" ON "kortix"."executor_connection_policies" USING btree ("profile_id");
