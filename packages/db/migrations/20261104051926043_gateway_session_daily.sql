-- Migration: gateway_session_daily
--
-- A settled-day rollup of gateway_request_logs at the grain the gateway
-- sessions list reads (project × UTC day × session × requested model), plus
-- the mark table gateway_session_days. The gateway-spend-backfill worker
-- recomputes each closed UTC day from the raw log rows
-- (settleLastGatewaySessionDay, apps/api/src/llm-gateway/session-rollup.ts)
-- and marks the day; listProjectGatewaySessionSpend reads the rollup for the
-- marked days and the raw rows for everything newer, so the two halves always
-- add up. This is the sessions-list sibling of 20261020122531072's
-- gateway_spend_daily: that one serves the budgets with an inline trigger,
-- this one serves the per-session list, whose raw multi-million-row aggregate
-- 5xx'd the route under load (KRTX-4021). No trigger here and no install-day
-- seed: with no marks the reader reads everything raw (today's behavior),
-- then the worker grinds one closed day per tick, oldest first.
--
--   * total_cost is the per-row rule of apps/api/src/shared/llm-spend.ts
--     (rowTotalSpendSql) and value the per-row rule of shared/llm-value.ts
--     (rowLlmValueSql, pricing snapshot pinned). A rule change must clear the
--     marks in a forward migration so the worker re-settles (the same
--     discipline as the spend trigger's pending-days re-seed).
--   * Days are settled OLD day first, one per worker tick, so the marks stay
--     contiguous: the reader's boundary is the first unmarked day in its
--     window, never a hole. Old days the worker misses while it is down drop
--     below the settle floor (370 days back) and are read raw forever —
--     slower, never wrong.
--   * Client roles revoked and RLS on with no policy: only the API reads
--     these.
--
-- ROLL BACK: no down migration (repo policy). A forward migration runs
--   DROP TABLE kortix.gateway_session_daily, kortix.gateway_session_days;
-- and the reader falls back to the raw SUM (revert the API first: the code
-- that reads the tables is gone with it).

-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

CREATE TABLE "kortix"."gateway_session_daily" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"session_id" text NOT NULL,
	"requested_model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric DEFAULT '0' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"value" numeric DEFAULT '0' NOT NULL,
	"value_rows" integer DEFAULT 0 NOT NULL,
	"unpriced_rows" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	CONSTRAINT "gateway_session_daily_pk" PRIMARY KEY("project_id","day","session_id","requested_model")
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_session_days" (
	"day" date PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."gateway_session_daily" ADD CONSTRAINT "gateway_session_daily_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gateway_session_daily_day" ON "kortix"."gateway_session_daily" USING btree ("day");--> statement-breakpoint
ALTER TABLE "kortix"."gateway_session_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_session_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."gateway_session_daily", "kortix"."gateway_session_days" FROM anon, authenticated;