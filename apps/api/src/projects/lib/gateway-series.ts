import { and, eq, sql } from 'drizzle-orm';
import { gatewayRequestLogs } from '@kortix/db';
import { db } from '../../shared/db';
import { llmValueFields } from '../../shared/llm-value';
import {
  kortixBilledSpendSql,
  providerBilledSpendSql,
  totalSpendSql,
} from '../../shared/llm-spend';

// One ordered-set aggregate yields all three percentiles from one sort of
// latency_ms per day group. Three `percentile_cont(x) within group` calls sort
// the same rows three times, which on the busiest project is most of the
// route's CPU (KRTX-4022).
const latencyPercentiles = sql<number[]>`percentile_cont(array[0.5, 0.95, 0.99]) within group (order by ${gatewayRequestLogs.latencyMs})`;

export function gatewaySeriesQuery(projectId: string, days: number) {
  return db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${gatewayRequestLogs.createdAt}), 'YYYY-MM-DD')`,
      ...llmValueFields,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
      cost: totalSpendSql,
      kortixCost: kortixBilledSpendSql,
      providerCost: providerBilledSpendSql,
      inputTokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${gatewayRequestLogs.outputTokens}), 0)`,
      latency: latencyPercentiles,
    })
    .from(gatewayRequestLogs)
    .where(
      and(
        eq(gatewayRequestLogs.projectId, projectId),
        sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${days})`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${gatewayRequestLogs.createdAt})`)
    .orderBy(sql`date_trunc('day', ${gatewayRequestLogs.createdAt})`);
}

/** Per-UTC-day usage rows of one project over the last `days` days (days with no request are absent). */
export async function gatewaySeriesRows(projectId: string, days: number) {
  const rows = await gatewaySeriesQuery(projectId, days);
  return rows.map(({ latency, ...row }) => {
    const [p50, p95, p99] = latency;
    return { ...row, p50: Math.round(p50 ?? 0), p95: Math.round(p95 ?? 0), p99: Math.round(p99 ?? 0) };
  });
}
