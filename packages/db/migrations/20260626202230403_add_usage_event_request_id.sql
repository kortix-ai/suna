-- Idempotency key for gateway-billed usage events. Nullable (zero-downtime):
-- only gateway turns set it; non-gateway usage events leave it NULL. The UNIQUE
-- index makes the LLM debit idempotent — a replay (reconciler backfill / retry)
-- hits the conflict, the second insert is skipped, and so is the duplicate debit.
-- NULLs are distinct in Postgres, so non-gateway rows are unconstrained.
--
-- NOTE: the drizzle snapshot regenerated alongside this also reconciled
-- pre-existing snapshot drift (the hand-written tunnel_relay_ownership migration
-- updated kortix.ts but not the drizzle snapshot). Those tunnel objects are
-- already created by 20260626012000000_tunnel_relay_ownership.sql, so they are
-- intentionally NOT re-emitted here — this migration applies only the
-- usage_events delta.
ALTER TABLE "kortix"."usage_events" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_usage_events_request_id" ON "kortix"."usage_events" USING btree ("request_id");
