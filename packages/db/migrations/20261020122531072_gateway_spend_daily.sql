-- Migration: gateway_spend_daily
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A running spend total per (project, UTC day, actor), kept by an AFTER INSERT
-- trigger on kortix.gateway_request_logs, so the gateway budgets read a few
-- hundred rows by primary key instead of summing up to 1.18M month-to-date log
-- rows (prod EXPLAIN 2026-10-20: 954 ms warm, 4.2 s cold).
--
--   * The trigger runs in the log INSERT's own statement: a row and its total
--     commit together or not at all. The table is insert-only (account
--     deletion removes the project too, which cascades here).
--     tests/unit/gateway-logs-insert-only.test.ts fails on any UPDATE or
--     DELETE of gateway_request_logs in apps/api/src or a later migration. A
--     cost correction must also re-insert the affected days into
--     gateway_spend_pending_days, so the backfill worker recomputes them.
--   * Trigger order is load-bearing. Postgres fires AFTER ROW triggers in
--     name order, so gateway_request_logs_project_audit (per-session audit
--     lock) fires before gateway_spend_daily_add (the hot per-project total
--     row). Reversed, an insert holds the project row lock while it waits on
--     a session lock, and every insert of that project queues behind it on
--     the audit pool (lock_timeout 2.5 s): inserts fail and spend goes
--     uncounted. Never rename either trigger to sort the other way.
--   * total_cost is the per-row rule of apps/api/src/shared/llm-spend.ts
--     (rowTotalSpendSql). numeric without a scale, so a sum of rows equals the
--     SUM over gateway_request_logs exactly.
--   * Days before this migration have no rows yet. They go into
--     gateway_spend_pending_days with the install day itself (partly counted).
--     The seed reads clock_timestamp(), not now(): it runs after CREATE
--     TRIGGER, so it covers the day the trigger went live even when this
--     transaction started before UTC midnight and took the lock after it.
--     Readers sum gateway_request_logs while a period overlaps a pending day.
--     The gateway-spend-backfill worker recomputes each closed day in its own
--     short transaction and removes it from the list. No backfill runs here:
--     the seed is at most 38 rows into a new table.
--   * Client roles revoked and RLS on with no policy: only the API reads these.
--
-- ROLL BACK: no down migration (repo policy). A forward migration runs
--   DROP TRIGGER gateway_spend_daily_add ON kortix.gateway_request_logs;
--   DROP FUNCTION kortix.gateway_spend_daily_add();
--   DROP TABLE kortix.gateway_spend_daily, kortix.gateway_spend_pending_days;
-- and the readers fall back to the log SUM (no pending row and no total row
-- means the code that reads them is gone too: revert the API first).

CREATE TABLE "kortix"."gateway_spend_daily" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric DEFAULT '0' NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "gateway_spend_daily_project_id_day_actor_user_id_pk" PRIMARY KEY("project_id","day","actor_user_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_spend_pending_days" (
	"day" date PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."gateway_spend_daily" ADD CONSTRAINT "gateway_spend_daily_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_spend_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_spend_pending_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."gateway_spend_daily", "kortix"."gateway_spend_pending_days" FROM anon, authenticated;--> statement-breakpoint
CREATE FUNCTION kortix.gateway_spend_daily_add()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO kortix.gateway_spend_daily AS d (project_id, day, actor_user_id, requests, total_cost, tokens)
  VALUES (
    NEW.project_id,
    (NEW.created_at AT TIME ZONE 'UTC')::date,
    coalesce(NEW.actor_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    1,
    NEW.final_cost_precise + CASE
      WHEN coalesce(NEW.billing_mode, CASE WHEN NEW.final_cost_precise > 0 THEN 'credits' ELSE 'none' END) = 'credits'
      THEN 0 ELSE NEW.upstream_cost_precise END,
    NEW.input_tokens::bigint + NEW.output_tokens
  )
  ON CONFLICT (project_id, day, actor_user_id) DO UPDATE SET
    requests = d.requests + 1,
    total_cost = d.total_cost + excluded.total_cost,
    tokens = d.tokens + excluded.tokens;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER gateway_spend_daily_add
AFTER INSERT ON kortix.gateway_request_logs
FOR EACH ROW
EXECUTE FUNCTION kortix.gateway_spend_daily_add();--> statement-breakpoint
-- backfill-safe: seeds at most 38 date rows into a table created above; no existing table is read or written.
INSERT INTO kortix.gateway_spend_pending_days (day)
SELECT generate_series(
  least(date_trunc('month', now() AT TIME ZONE 'UTC'), date_trunc('week', now() AT TIME ZONE 'UTC'))::date,
  (clock_timestamp() AT TIME ZONE 'UTC')::date,
  interval '1 day'
)::date;
