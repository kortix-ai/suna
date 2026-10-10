import { numberValue, isoValue } from './cost-values';
import { gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { CostSort, CostWindow } from './cost-window';
import { db } from './db';
import { kortixBilledSpendSql, providerBilledSpendSql } from './llm-spend';
import { billedComputeSecondsExpression } from './session-costs';

export interface ProjectCostRow {
  project_id: string;
  project_name: string;
  session_count: number;
  llm_cost: number;
  /** Alias of `llm_cost`, retained for the additive payee breakdown. */
  llm_kortix_cost: number;
  /** Provider-side BYOK spend. Excluded from `llm_cost` and `total_cost`. */
  llm_provider_cost: number;
  compute_cost: number;
  total_cost: number;
  last_activity_at: string | null;
}

export interface ProjectCostPage {
  projects: ProjectCostRow[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

interface LlmProjectAggregateRow {
  projectId: string | null;
  llmCost: number | string;
  llmKortixCost?: number | string;
  llmProviderCost?: number | string;
  sessionCount: number | string;
  lastAt: Date | string | null;
}

interface ComputeProjectAggregateRow {
  projectId: string | null;
  computeCost: number | string;
  sessionCount: number | string;
  lastAt: Date | string | null;
}

function laterIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

// Pure merge of the two windowed, per-project aggregates into one row per
// project. Both inputs already carry numeric-ish values straight out of a
// `coalesce(sum(...), 0)::float8` — this never re-sums money itself, it only
// combines the two already-summed totals.
export function mergeProjectCostRows(
  llmRows: LlmProjectAggregateRow[],
  computeRows: ComputeProjectAggregateRow[],
  projectNames: Map<string, string>,
): ProjectCostRow[] {
  const byProject = new Map<string, ProjectCostRow>();

  const ensure = (projectId: string): ProjectCostRow => {
    const existing = byProject.get(projectId);
    if (existing) return existing;
    const created: ProjectCostRow = {
      project_id: projectId,
      project_name: projectNames.get(projectId) ?? projectId,
      session_count: 0,
      llm_cost: 0,
      llm_kortix_cost: 0,
      llm_provider_cost: 0,
      compute_cost: 0,
      total_cost: 0,
      last_activity_at: null,
    };
    byProject.set(projectId, created);
    return created;
  };

  for (const row of llmRows) {
    if (!row.projectId) continue;
    const target = ensure(row.projectId);
    target.llm_cost = numberValue(row.llmCost);
    target.llm_kortix_cost = numberValue(row.llmKortixCost);
    target.llm_provider_cost = numberValue(row.llmProviderCost);
    target.session_count = Math.max(target.session_count, numberValue(row.sessionCount));
    target.last_activity_at = laterIso(target.last_activity_at, isoValue(row.lastAt));
  }

  for (const row of computeRows) {
    if (!row.projectId) continue;
    const target = ensure(row.projectId);
    target.compute_cost = numberValue(row.computeCost);
    target.session_count = Math.max(target.session_count, numberValue(row.sessionCount));
    target.last_activity_at = laterIso(target.last_activity_at, isoValue(row.lastAt));
  }

  for (const row of byProject.values()) {
    row.total_cost = Number((row.llm_cost + row.compute_cost).toFixed(10));
  }

  return [...byProject.values()];
}

// The JS mirror of the project rollup's order. This IS the sort, not a
// redundant re-statement of one Postgres already did: listCostByProject pages
// entirely in memory (see the comment there), so nothing upstream orders
// these rows before this runs. Ties always break on project_id so the
// slice() below is a total order — without it a row could land on two pages
// or on none, the same hazard the SQL ORDER BY guards against in
// session-costs.ts.
export function sortProjectRows(rows: ProjectCostRow[], sort: CostSort): ProjectCostRow[] {
  const compare = (left: ProjectCostRow, right: ProjectCostRow): number => {
    let delta: number;
    switch (sort) {
      case 'name_asc':
        delta = left.project_name.localeCompare(right.project_name);
        break;
      case 'recent':
        delta = (right.last_activity_at ?? '').localeCompare(left.last_activity_at ?? '');
        break;
      case 'total_asc':
        delta = left.total_cost - right.total_cost;
        break;
      case 'total_desc':
        delta = right.total_cost - left.total_cost;
        break;
      default: {
        const unsupported: never = sort;
        throw new Error(`unsupported sort: ${String(unsupported)}`);
      }
    }
    return delta || left.project_id.localeCompare(right.project_id);
  };
  return [...rows].sort(compare);
}

// LLM rows carry project_id directly (idx_gateway_logs_project_time). Compute
// rows do not: they reach project_id by joining project_sessions, whose
// session_id is the primary key — a PK join, not a scan.
export async function listCostByProject(input: {
  accountId: string;
  projectId?: string;
  window: CostWindow;
  sort: CostSort;
  limit: number;
  offset: number;
}): Promise<ProjectCostPage> {
  const { accountId, window } = input;

  const [llmRows, computeRows, projectRows] = await Promise.all([
    db
      .select({
        projectId: gatewayRequestLogs.projectId,
        llmCost: kortixBilledSpendSql,
        llmKortixCost: kortixBilledSpendSql,
        llmProviderCost: providerBilledSpendSql,
        sessionCount: sql<number>`count(distinct ${gatewayRequestLogs.sessionId})::int`,
        lastAt: sql<Date | null>`max(${gatewayRequestLogs.createdAt})`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, accountId),
          input.projectId ? eq(gatewayRequestLogs.projectId, input.projectId) : undefined,
          // createdAt is a Date-mode timestamp, so the bounds are Date objects.
          gte(gatewayRequestLogs.createdAt, window.from),
          lt(gatewayRequestLogs.createdAt, window.to),
          sql`${gatewayRequestLogs.projectId} is not null`,
        ),
      )
      .groupBy(gatewayRequestLogs.projectId),
    db
      .select({
        projectId: projectSessions.projectId,
        computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        sessionCount: sql<number>`count(distinct ${sandboxComputeSessions.sessionId})::int`,
        lastAt: sql<string | null>`max(${sandboxComputeSessions.lastBilledAt})`,
      })
      .from(sandboxComputeSessions)
      .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(
        and(
          eq(sandboxComputeSessions.accountId, accountId),
          input.projectId ? eq(projectSessions.projectId, input.projectId) : undefined,
          // startedAt is declared mode:'string', so the bounds are ISO strings.
          // Never last_billed_at — its only index is partial (WHERE state =
          // 'active'), built for the biller, not for windowed reporting.
          gte(sandboxComputeSessions.startedAt, window.from.toISOString()),
          lt(sandboxComputeSessions.startedAt, window.to.toISOString()),
        ),
      )
      .groupBy(projectSessions.projectId),
    db
      .select({ projectId: projects.projectId, name: projects.name })
      .from(projects)
      .where(and(
        eq(projects.accountId, accountId),
        input.projectId ? eq(projects.projectId, input.projectId) : undefined,
      )),
  ]);

  const projectNames = new Map(projectRows.map((row) => [row.projectId, row.name]));
  const merged = sortProjectRows(
    mergeProjectCostRows(llmRows, computeRows, projectNames),
    input.sort,
  );

  // Paging happens in memory, on purpose: an account has tens to hundreds of
  // projects, not millions, and both grouped queries above are already
  // window-bounded by an index (idx_gateway_logs_account_time /
  // idx_sandbox_compute_sessions_account_time). Sessions page in SQL instead
  // (listSessionCosts in session-costs.ts) because they can number in the
  // tens of thousands — do not "fix" this into a SQL LIMIT/OFFSET.
  const page = merged.slice(input.offset, input.offset + input.limit);

  return {
    projects: page,
    total: merged.length,
    limit: input.limit,
    offset: input.offset,
    next_offset: input.offset + page.length < merged.length ? input.offset + page.length : null,
  };
}

export interface CostSeriesPoint {
  day: string;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
}

interface DailyCostRow {
  day: string;
  cost: number | string;
}

// The equally long window immediately before `window`: [from - span, from).
// Half-open like every CostWindow. Pure so the boundary math (month/day
// crossings, single-day windows) is unit-testable without a database.
export function previousWindow(window: CostWindow): CostWindow {
  const span = window.to.getTime() - window.from.getTime();
  return {
    from: new Date(window.from.getTime() - span),
    to: new Date(window.from.getTime()),
  };
}

// Gap days are emitted as zero, not omitted. A chart that silently skips
// empty days compresses time and makes a spike look like a trend.
export function buildCostSeries(
  llmDays: DailyCostRow[],
  computeDays: DailyCostRow[],
  window: CostWindow,
): CostSeriesPoint[] {
  const llmByDay = new Map(llmDays.map((row) => [row.day, numberValue(row.cost)]));
  const computeByDay = new Map(computeDays.map((row) => [row.day, numberValue(row.cost)]));

  const points: CostSeriesPoint[] = [];
  const cursor = new Date(
    Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), window.from.getUTCDate()),
  );

  while (cursor.getTime() < window.to.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const llmCost = llmByDay.get(day) ?? 0;
    const computeCost = computeByDay.get(day) ?? 0;
    points.push({
      day,
      llm_cost: llmCost,
      compute_cost: computeCost,
      total_cost: Number((llmCost + computeCost).toFixed(10)),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}

export interface CostSummaryTotals {
  llm_cost: number;
  /** Alias of `llm_cost`, retained for the additive payee breakdown. */
  llm_kortix_cost: number;
  /** Provider-side BYOK spend. Excluded from `llm_cost` and `total_cost`. */
  llm_provider_cost: number;
  compute_cost: number;
  total_cost: number;
  request_count: number;
  compute_seconds: number;
  session_count: number;
  project_count: number;
}

export interface CostModelRow {
  provider: string;
  model: string;
  cost: number;
  request_count: number;
}

export interface CostSummary {
  totals: CostSummaryTotals;
  previous: { total_cost: number };
  series: CostSeriesPoint[];
  models: CostModelRow[];
}

// UTC day bucket for the LLM daily series, keyed off created_at (Date-mode).
const LLM_DAY_EXPRESSION = sql<string>`to_char(date_trunc('day', ${gatewayRequestLogs.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
// UTC day bucket for the compute daily series, keyed off started_at. The
// underlying column is timestamptz regardless of the client-side string
// mode, so `at time zone 'UTC'` on the raw column is valid the same way.
const COMPUTE_DAY_EXPRESSION = sql<string>`to_char(date_trunc('day', ${sandboxComputeSessions.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

/**
 * Which grouping set a grouped-scan row belongs to.
 *
 * `grouping(expr)` is 1 when `expr` is NOT a grouping column of the row's
 * set — decided by the GROUP BY, never by the data. Each set below has
 * exactly one expression with `grouping() = 0`, except the grand total
 * (none), so one CASE labels every row. Dispatching on the null shape of
 * the projected columns instead would silently misroute the day a provider
 * or a day expression ever returns NULL — the label must come from the
 * query plan, not from the data.
 */
const LLM_SET_ID = sql<string>`case
  when grouping(${gatewayRequestLogs.provider}) = 0 then 'model'
  when grouping(${LLM_DAY_EXPRESSION}) = 0 then 'day'
  when grouping(${gatewayRequestLogs.projectId}) = 0 then 'project'
  else 'totals'
end`;

const COMPUTE_SET_ID = sql<string>`case
  when grouping(${COMPUTE_DAY_EXPRESSION}) = 0 then 'day'
  when grouping(${projectSessions.projectId}) = 0 then 'project'
  else 'totals'
end`;

// Scoped, windowed spend totals, a gap-filled daily series, the top 10
// models by spend, and the prior equal-length window's total for a period
// delta. One function serves all three cost explorer levels: account-wide
// when neither projectId nor sessionId is supplied, one project when
// projectId is supplied, one session when sessionId is supplied.
export async function getCostSummary(input: {
  accountId: string;
  projectId?: string;
  sessionId?: string;
  window: CostWindow;
}): Promise<CostSummary> {
  const { accountId, projectId, sessionId, window } = input;

  const llmScope = (w: CostWindow) => {
    const conditions = [
      eq(gatewayRequestLogs.accountId, accountId),
      // createdAt is a Date-mode timestamp, so the bounds are Date objects.
      gte(gatewayRequestLogs.createdAt, w.from),
      lt(gatewayRequestLogs.createdAt, w.to),
    ];
    if (projectId) conditions.push(eq(gatewayRequestLogs.projectId, projectId));
    if (sessionId) conditions.push(eq(gatewayRequestLogs.sessionId, sessionId));
    return and(...conditions);
  };

  // Compute rows carry no project_id of their own — reaching it means
  // joining project_sessions (session_id is its primary key, as in
  // listCostByProject above). The grouped scan LEFT JOINs project_sessions
  // always: the grand-total set must still cover compute cost from sessions
  // with no project_sessions row (the account-wide total includes unassigned
  // spend — the same constraint loadReconciliation in session-costs.ts
  // enforces with a LEFT JOIN), and a LEFT JOIN keeps every row. When
  // scoping to one project the ps.project_id predicate in the WHERE makes
  // the LEFT JOIN behave exactly like the INNER JOIN the ungrouped version
  // used (a right side that fails the predicate drops the row, matched or
  // not), and the project grouping set then sees only that project.
  const computeScope = (w: CostWindow) => {
    const conditions = [
      eq(sandboxComputeSessions.accountId, accountId),
      // startedAt is declared mode:'string', so the bounds are ISO strings.
      // Never last_billed_at — its only index is partial (WHERE state =
      // 'active'), built for the biller, not for windowed reporting.
      gte(sandboxComputeSessions.startedAt, w.from.toISOString()),
      lt(sandboxComputeSessions.startedAt, w.to.toISOString()),
    ];
    if (sessionId) conditions.push(eq(sandboxComputeSessions.sessionId, sessionId));
    if (projectId) conditions.push(eq(projectSessions.projectId, projectId));
    return and(...conditions);
  };

  const previous = previousWindow(window);

  // The prior-window compute total carries no project attribution of its
  // own, but computeScope still filters on project_sessions.project_id
  // when a project scope is set — so the join exists exactly when that
  // predicate needs it (an INNER join, as before: at project scope every
  // surviving row must match the project). Drizzle's joined and unjoined
  // builders are differently-typed chain objects, so the branch awaits
  // inside each arm rather than unifying them at a ternary.
  function loadComputePrior(w: CostWindow) {
    if (projectId) {
      return db
        .select({ cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8` })
        .from(sandboxComputeSessions)
        .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
        .where(computeScope(w));
    }
    return db
      .select({ cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8` })
      .from(sandboxComputeSessions)
      .where(computeScope(w));
  }

  // One grouped scan per source per window. Prod Server-Timing (2026-10-04,
  // the largest account) showed this route spending db;dur=4.5–25s across
  // n=10 statements: five independent scans of the same 30-day
  // gateway_request_logs window and four of sandbox_compute_sessions, each
  // re-reading the same heap pages, with repeats after the first load
  // settling at ~0.1s once the buffer cache was warm. The scan itself is
  // the cost — GROUPING SETS computes totals, the daily series, the model
  // breakdown and the distinct-project list from a single pass, keeping
  // every figure identical to the one-query-per-figure version.
  const [llmGroupRows, llmPriorRows, computeGroupRows, computePriorRows] = await Promise.all([
    db
      .select({
        setId: LLM_SET_ID,
        provider: gatewayRequestLogs.provider,
        model: gatewayRequestLogs.resolvedModel,
        day: LLM_DAY_EXPRESSION,
        projectId: gatewayRequestLogs.projectId,
        llmCost: kortixBilledSpendSql,
        llmKortixCost: kortixBilledSpendSql,
        llmProviderCost: providerBilledSpendSql,
        requestCount: sql<number>`count(*)::int`,
        sessionCount: sql<number>`count(distinct ${gatewayRequestLogs.sessionId})::int`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(
        sql`grouping sets (
          (${gatewayRequestLogs.provider}, ${gatewayRequestLogs.resolvedModel}),
          (${LLM_DAY_EXPRESSION}),
          (${gatewayRequestLogs.projectId}),
          ()
        )`,
      ),
    db
      .select({ cost: kortixBilledSpendSql })
      .from(gatewayRequestLogs)
      .where(llmScope(previous)),
    db
      .select({
        setId: COMPUTE_SET_ID,
        day: COMPUTE_DAY_EXPRESSION,
        projectId: projectSessions.projectId,
        computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        computeSeconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}), 0)::float8`,
        sessionCount: sql<number>`count(distinct ${sandboxComputeSessions.sessionId})::int`,
      })
      .from(sandboxComputeSessions)
      .leftJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(computeScope(window))
      .groupBy(
        sql`grouping sets (
          (${COMPUTE_DAY_EXPRESSION}),
          (${projectSessions.projectId}),
          ()
        )`,
      ),
    loadComputePrior(previous),
  ]);

  // Split the grouped rows by their set label. The grand-total row is the
  // one row whose set has no grouping column; an empty window still returns
  // it (aggregate without GROUP BY), while every grouped set returns none —
  // the same shapes the per-query version produced.
  const llmTotals = llmGroupRows.find((row) => row.setId === 'totals');
  const computeTotals = computeGroupRows.find((row) => row.setId === 'totals');

  const llmDailyRows: DailyCostRow[] = [];
  const computeDailyRows: DailyCostRow[] = [];
  for (const row of llmGroupRows) {
    if (row.setId === 'day' && row.day) llmDailyRows.push({ day: row.day, cost: row.llmCost });
  }
  for (const row of computeGroupRows) {
    if (row.setId === 'day' && row.day) computeDailyRows.push({ day: row.day, cost: row.computeCost });
  }

  // The true union of distinct project ids across both sources, not just
  // the LLM side's count: a project can have compute spend and zero
  // gateway_request_logs rows in the window (a session whose compute
  // started inside the window but whose LLM calls fell outside it, or a
  // project on BYO keys with no gateway rows at all), and listCostByProject
  // above already treats such a project as real (mergeProjectCostRows's
  // compute loop calls ensure(row.projectId) same as the LLM loop). The
  // grouping sets produce this as the rows of each source's project set;
  // the compute side's LEFT JOIN adds a NULL group for unassigned spend,
  // which the `row.projectId` guard drops the same way the ungrouped
  // version's INNER JOIN never saw those rows at all.
  const projectIds = new Set<string>();
  for (const row of llmGroupRows) {
    if (row.setId === 'project' && row.projectId) projectIds.add(row.projectId);
  }
  for (const row of computeGroupRows) {
    if (row.setId === 'project' && row.projectId) projectIds.add(row.projectId);
  }

  // Cost descending, then provider/model descending as a deterministic
  // tie-break — the same rule the ungrouped version ordered by in SQL.
  // ponytail: the tie-break compares code units, not the DB collation —
  // identical for the ASCII provider/model slugs; move the ordering back
  // into SQL (a per-set LIMIT can't live inside GROUPING SETS) if a
  // non-ASCII model name ever needs exact SQL tie order.
  const models = llmGroupRows
    .filter((row) => row.setId === 'model')
    .map((row) => {
      // Unreachable by construction: provider and resolved_model are the
      // grouping columns of the 'model' set and both are NOT NULL in the
      // table, so a 'model' row always carries both. The guard narrows
      // without a cast and fails loudly if the set marker or the schema
      // ever drifts.
      if (!row.provider || !row.model) {
        throw new Error(`model grouping-set row without provider/model: ${JSON.stringify(row)}`);
      }
      return {
        provider: row.provider,
        model: row.model,
        cost: numberValue(row.llmCost),
        request_count: numberValue(row.requestCount),
      };
    })
    .sort((left, right) => {
      const byCost = right.cost - left.cost;
      if (byCost) return byCost;
      if (left.provider !== right.provider) return left.provider < right.provider ? 1 : -1;
      if (left.model === right.model) return 0;
      return left.model < right.model ? 1 : -1;
    })
    .slice(0, 10);

  const llmCost = numberValue(llmTotals?.llmCost);
  const computeCost = numberValue(computeTotals?.computeCost);

  const totals: CostSummaryTotals = {
    llm_cost: llmCost,
    llm_kortix_cost: numberValue(llmTotals?.llmKortixCost),
    llm_provider_cost: numberValue(llmTotals?.llmProviderCost),
    compute_cost: computeCost,
    total_cost: Number((llmCost + computeCost).toFixed(10)),
    request_count: numberValue(llmTotals?.requestCount),
    compute_seconds: numberValue(computeTotals?.computeSeconds),
    // The larger of the two sources' distinct session counts — NOT the true
    // union: a session with LLM-only spend and a different session with
    // compute-only spend both go uncounted by Math.max the same way they
    // would under- or over-count with either side alone. This follows
    // mergeProjectCostRows's established convention above (same
    // approximation, same tradeoff) rather than diverging with a more
    // accurate but novel calculation.
    session_count: Math.max(
      numberValue(llmTotals?.sessionCount),
      numberValue(computeTotals?.sessionCount),
    ),
    // The true union of distinct project ids across both sources, not just
    // the LLM side's count: a project can have compute spend and zero
    // gateway_request_logs rows in the window (a session whose compute
    // started inside the window but whose LLM calls fell outside it, or a
    // project on BYO keys with no gateway rows at all), and listCostByProject
    // above already treats such a project as real (mergeProjectCostRows's
    // compute loop calls ensure(row.projectId) same as the LLM loop). This is
    // a separate, non-money query (projectIds), so it does not touch the
    // total_cost completeness constraint documented on computeScope above —
    // that constraint binds the money queries, not a distinct-id count.
    project_count: projectIds.size,
  };

  const previousTotalCost = Number(
    (numberValue(llmPriorRows[0]?.cost) + numberValue(computePriorRows[0]?.cost)).toFixed(10),
  );

  return {
    totals,
    previous: { total_cost: previousTotalCost },
    series: buildCostSeries(llmDailyRows, computeDailyRows, window),
    models,
  };
}
