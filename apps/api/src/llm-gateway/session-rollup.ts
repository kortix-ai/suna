import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { rowTotalSpendSql } from '../shared/llm-spend';
import { rowLlmValueSql } from '../shared/llm-value';

/**
 * The settled-day rollup the gateway sessions reader reads
 * (listProjectGatewaySessionSpend, apps/api/src/shared/session-costs.ts):
 * recompute one closed UTC day of gateway_session_daily from the raw log rows
 * and mark the day. This is the per-session sibling of settleGatewaySpendDay
 * (budgets.ts) — that one refreshes the spend trigger's pending days, this
 * one rolls the day up itself because no trigger maintains these rows inline.
 *
 * One day per call, oldest first, so the marks stay contiguous: the reader's
 * boundary is the FIRST day in its window with no mark, never a hole. A day
 * counts as closed 10 minutes past UTC midnight, the same rule
 * settleGatewaySpendDay uses (a log INSERT's created_at is its statement
 * start, and the audit pool that runs the INSERT ends it long before that).
 *
 * The rollup money columns must keep matching what the reader sums raw:
 * total_cost = rowTotalSpendSql and value = rowLlmValueSql with its pinned
 * pricing snapshot. A rule change needs a forward migration that clears the
 * marks (the worker then re-settles every day) and the reader deploy in the
 * same release — the same discipline the spend trigger's pending days follow.
 */
export async function settleLastGatewaySessionDay(): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The oldest closed day with no mark, starting one day past the newest
    // mark (371 days back before the first mark — farther than any reader's
    // 365-day window reaches) and ending at the last closed day. `now()` is
    // frozen for the whole statement, so the day arithmetic inside is one
    // coherent instant.
    const [day] = await tx.execute<{ day: string }>(sql`
      select min(gs)::date::text as day
      from generate_series(
        coalesce(
          (select max(day) + 1 from kortix.gateway_session_days),
          ((now() - interval '371 days') at time zone 'UTC')::date
        )::date::timestamp,
        (((now() - interval '10 minutes') at time zone 'UTC')::date - 1)::timestamp,
        interval '1 day'
      ) as gs`);
    const dayString = day?.day;
    if (!dayString) return false;
    // The mark's INSERT ... ON CONFLICT DO NOTHING makes a double settle of
    // one day harmless (the worker is leader-only; two API instances racing a
    // tick would just recompute the same rows twice).
    await tx.execute(sql`
      delete from kortix.gateway_session_daily where day = ${dayString}::date`);
    await tx.execute(sql`
      insert into kortix.gateway_session_daily
        (project_id, day, session_id, requested_model, requests, errors,
         total_cost, input_tokens, output_tokens, value, value_rows, unpriced_rows, last_at)
      select project_id, ${dayString}::date, session_id, requested_model,
        count(*)::int,
        count(*) filter (where not ok)::int,
        sum(${rowTotalSpendSql}),
        sum(input_tokens::bigint),
        sum(output_tokens::bigint),
        coalesce(sum(${rowLlmValueSql}), 0),
        count(${rowLlmValueSql})::int,
        count(*) filter (where ok and ${rowLlmValueSql} is null)::int,
        max(created_at)
      from kortix.gateway_request_logs
      where project_id is not null
        and session_id is not null
        and created_at >= (${dayString}::date)::timestamp at time zone 'UTC'
        and created_at < (${dayString}::date + 1)::timestamp at time zone 'UTC'
      group by 1, 3, 4`);
    await tx.execute(sql`
      insert into kortix.gateway_session_days (day) values (${dayString}::date) on conflict do nothing`);
    return true;
  });
}
