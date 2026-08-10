import { gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';

import type { CostSort, CostWindow } from './cost-window';
import { db } from './db';
import { billedComputeSecondsExpression } from './session-costs';

export interface WorkspaceCostRow {
  project_id: string;
  project_name: string;
  session_count: number;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  last_activity_at: string | null;
}

export interface WorkspaceCostPage {
  projects: WorkspaceCostRow[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

interface LlmWorkspaceAggregateRow {
  workspaceId: string | null;
  llmCost: number | string;
  sessionCount: number | string;
  lastAt: Date | string | null;
}

interface ComputeWorkspaceAggregateRow {
  workspaceId: string | null;
  computeCost: number | string;
  sessionCount: number | string;
  lastAt: Date | string | null;
}

function numberValue(value: number | string | null | undefined): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function isoValue(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
export function mergeWorkspaceCostRows(
  llmRows: LlmWorkspaceAggregateRow[],
  computeRows: ComputeWorkspaceAggregateRow[],
  projectNames: Map<string, string>,
): WorkspaceCostRow[] {
  const byWorkspace = new Map<string, WorkspaceCostRow>();

  const ensure = (workspaceId: string): WorkspaceCostRow => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceCostRow = {
      project_id: workspaceId,
      project_name: projectNames.get(workspaceId) ?? workspaceId,
      session_count: 0,
      llm_cost: 0,
      compute_cost: 0,
      total_cost: 0,
      last_activity_at: null,
    };
    byWorkspace.set(workspaceId, created);
    return created;
  };

  for (const row of llmRows) {
    if (!row.workspaceId) continue;
    const target = ensure(row.workspaceId);
    target.llm_cost = numberValue(row.llmCost);
    target.session_count = Math.max(target.session_count, numberValue(row.sessionCount));
    target.last_activity_at = laterIso(target.last_activity_at, isoValue(row.lastAt));
  }

  for (const row of computeRows) {
    if (!row.workspaceId) continue;
    const target = ensure(row.workspaceId);
    target.compute_cost = numberValue(row.computeCost);
    target.session_count = Math.max(target.session_count, numberValue(row.sessionCount));
    target.last_activity_at = laterIso(target.last_activity_at, isoValue(row.lastAt));
  }

  for (const row of byWorkspace.values()) {
    row.total_cost = Number((row.llm_cost + row.compute_cost).toFixed(10));
  }

  return [...byWorkspace.values()];
}

// The JS mirror of the project rollup's order. This IS the sort, not a
// redundant re-statement of one Postgres already did: listCostByWorkspace pages
// entirely in memory (see the comment there), so nothing upstream orders
// these rows before this runs. Ties always break on project_id so the
// slice() below is a total order — without it a row could land on two pages
// or on none, the same hazard the SQL ORDER BY guards against in
// session-costs.ts.
export function sortWorkspaceRows(rows: WorkspaceCostRow[], sort: CostSort): WorkspaceCostRow[] {
  const compare = (left: WorkspaceCostRow, right: WorkspaceCostRow): number => {
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
export async function listCostByWorkspace(input: {
  accountId: string;
  window: CostWindow;
  sort: CostSort;
  limit: number;
  offset: number;
}): Promise<WorkspaceCostPage> {
  const { accountId, window } = input;

  const [llmRows, computeRows, projectRows] = await Promise.all([
    db
      .select({
        workspaceId: gatewayRequestLogs.workspaceId,
        llmCost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        sessionCount: sql<number>`count(distinct ${gatewayRequestLogs.sessionId})::int`,
        lastAt: sql<Date | null>`max(${gatewayRequestLogs.createdAt})`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, accountId),
          // createdAt is a Date-mode timestamp, so the bounds are Date objects.
          gte(gatewayRequestLogs.createdAt, window.from),
          lt(gatewayRequestLogs.createdAt, window.to),
          sql`${gatewayRequestLogs.workspaceId} is not null`,
        ),
      )
      .groupBy(gatewayRequestLogs.workspaceId),
    db
      .select({
        workspaceId: projectSessions.workspaceId,
        computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        sessionCount: sql<number>`count(distinct ${sandboxComputeSessions.sessionId})::int`,
        lastAt: sql<string | null>`max(${sandboxComputeSessions.lastBilledAt})`,
      })
      .from(sandboxComputeSessions)
      .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(
        and(
          eq(sandboxComputeSessions.accountId, accountId),
          // startedAt is declared mode:'string', so the bounds are ISO strings.
          // Never last_billed_at — its only index is partial (WHERE state =
          // 'active'), built for the biller, not for windowed reporting.
          gte(sandboxComputeSessions.startedAt, window.from.toISOString()),
          lt(sandboxComputeSessions.startedAt, window.to.toISOString()),
        ),
      )
      .groupBy(projectSessions.workspaceId),
    db
      .select({ workspaceId: projects.workspaceId, name: projects.name })
      .from(projects)
      .where(eq(projects.accountId, accountId)),
  ]);

  const projectNames = new Map(projectRows.map((row) => [row.workspaceId, row.name]));
  const merged = sortWorkspaceRows(
    mergeWorkspaceCostRows(llmRows, computeRows, projectNames),
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

interface ComputeTotalsRow {
  computeCost: number | string;
  computeSeconds: number | string;
  sessionCount: number | string;
}

interface ComputeDailyRow {
  day: string;
  cost: number | string;
}

interface ComputePriorRow {
  cost: number | string;
}

// Scoped, windowed spend totals, a gap-filled daily series, the top 10
// models by spend, and the prior equal-length window's total for a period
// delta. One function serves all three cost explorer levels: account-wide
// when neither workspaceId nor sessionId is supplied, one project when
// workspaceId is supplied, one session when sessionId is supplied.
export async function getCostSummary(input: {
  accountId: string;
  workspaceId?: string;
  sessionId?: string;
  window: CostWindow;
}): Promise<CostSummary> {
  const { accountId, workspaceId, sessionId, window } = input;

  const llmScope = (w: CostWindow) => {
    const conditions = [
      eq(gatewayRequestLogs.accountId, accountId),
      // createdAt is a Date-mode timestamp, so the bounds are Date objects.
      gte(gatewayRequestLogs.createdAt, w.from),
      lt(gatewayRequestLogs.createdAt, w.to),
    ];
    if (workspaceId) conditions.push(eq(gatewayRequestLogs.workspaceId, workspaceId));
    if (sessionId) conditions.push(eq(gatewayRequestLogs.sessionId, sessionId));
    return and(...conditions);
  };

  // Compute rows carry no project_id of their own — reaching it means
  // joining project_sessions (session_id is its primary key, as in
  // listCostByWorkspace above). The join is added only when scoping to one
  // project: joining unconditionally would inner-join away compute cost from
  // sessions with no project_sessions row, silently undercounting the
  // account-wide total. This endpoint's totals.total_cost must cover ALL
  // account spend in the window — the same constraint loadReconciliation in
  // session-costs.ts enforces with a LEFT JOIN for the same reason.
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
    if (workspaceId) conditions.push(eq(projectSessions.workspaceId, workspaceId));
    return and(...conditions);
  };

  const computeTotalsFields = {
    computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
    computeSeconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}), 0)::float8`,
    sessionCount: sql<number>`count(distinct ${sandboxComputeSessions.sessionId})::int`,
  };
  const computeDailyFields = {
    day: COMPUTE_DAY_EXPRESSION,
    cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
  };
  const computePriorFields = {
    cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
  };

  // Each loader branches on whether the project_sessions join is needed and
  // awaits inside the branch, rather than assigning a not-yet-awaited query
  // built by a ternary — Drizzle's joined and unjoined builders are
  // differently-typed chain objects, and unifying them at the ternary
  // (instead of at the already-resolved Promise) is exactly the kind of
  // ambiguity the brief's Step 5 pseudocode (`computeBase`) glossed over.
  function loadComputeTotals(w: CostWindow): Promise<ComputeTotalsRow[]> {
    if (workspaceId) {
      return db
        .select(computeTotalsFields)
        .from(sandboxComputeSessions)
        .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
        .where(computeScope(w));
    }
    return db.select(computeTotalsFields).from(sandboxComputeSessions).where(computeScope(w));
  }

  function loadComputeDaily(w: CostWindow): Promise<ComputeDailyRow[]> {
    if (workspaceId) {
      return db
        .select(computeDailyFields)
        .from(sandboxComputeSessions)
        .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
        .where(computeScope(w))
        .groupBy(COMPUTE_DAY_EXPRESSION);
    }
    return db
      .select(computeDailyFields)
      .from(sandboxComputeSessions)
      .where(computeScope(w))
      .groupBy(COMPUTE_DAY_EXPRESSION);
  }

  function loadComputePrior(w: CostWindow): Promise<ComputePriorRow[]> {
    if (workspaceId) {
      return db
        .select(computePriorFields)
        .from(sandboxComputeSessions)
        .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
        .where(computeScope(w));
    }
    return db.select(computePriorFields).from(sandboxComputeSessions).where(computeScope(w));
  }

  const previous = previousWindow(window);

  // A dedicated, non-money query pair for project_count: the true union of
  // distinct project ids touched by either source, not just the LLM side's
  // count (see the comment on totals.project_count below for why the LLM
  // side alone undercounts). The compute side is always joined to
  // project_sessions here — unlike computeTotals/computeDaily/computePrior,
  // this query carries no money, so there is no completeness constraint to
  // protect: a compute row with no project_sessions match has no project to
  // attribute to a distinct-project count in the first place.
  const llmWorkspaceIdsQuery = db
    .select({ workspaceId: gatewayRequestLogs.workspaceId })
    .from(gatewayRequestLogs)
    .where(and(llmScope(window), sql`${gatewayRequestLogs.workspaceId} is not null`))
    .groupBy(gatewayRequestLogs.workspaceId);

  const computeWorkspaceIdsQuery = db
    .select({ workspaceId: projectSessions.workspaceId })
    .from(sandboxComputeSessions)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
    .where(computeScope(window))
    .groupBy(projectSessions.workspaceId);

  const [
    llmTotalsRows,
    llmDailyRows,
    modelRows,
    llmPriorRows,
    llmWorkspaceIdRows,
    computeTotalsRows,
    computeDailyRows,
    computePriorRows,
    computeWorkspaceIdRows,
  ] = await Promise.all([
    db
      .select({
        llmCost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        requestCount: sql<number>`count(*)::int`,
        sessionCount: sql<number>`count(distinct ${gatewayRequestLogs.sessionId})::int`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window)),
    db
      .select({
        day: LLM_DAY_EXPRESSION,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(LLM_DAY_EXPRESSION),
    db
      .select({
        provider: gatewayRequestLogs.provider,
        model: gatewayRequestLogs.resolvedModel,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(gatewayRequestLogs.provider, gatewayRequestLogs.resolvedModel)
      // Cost descending, then provider/model descending as a deterministic
      // tie-break — without it, which model lands on the 10th row of a tie
      // is unspecified and can flip between refreshes.
      .orderBy(
        desc(sql`sum(${gatewayRequestLogs.finalCost})`),
        desc(gatewayRequestLogs.provider),
        desc(gatewayRequestLogs.resolvedModel),
      )
      .limit(10),
    db
      .select({ cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8` })
      .from(gatewayRequestLogs)
      .where(llmScope(previous)),
    llmWorkspaceIdsQuery,
    loadComputeTotals(window),
    loadComputeDaily(window),
    loadComputePrior(previous),
    computeWorkspaceIdsQuery,
  ]);

  const projectIds = new Set<string>();
  for (const row of llmWorkspaceIdRows) if (row.workspaceId) projectIds.add(row.workspaceId);
  for (const row of computeWorkspaceIdRows) if (row.workspaceId) projectIds.add(row.workspaceId);

  const llmTotals = llmTotalsRows[0];
  const computeTotals = computeTotalsRows[0];
  const llmCost = numberValue(llmTotals?.llmCost);
  const computeCost = numberValue(computeTotals?.computeCost);

  const totals: CostSummaryTotals = {
    llm_cost: llmCost,
    compute_cost: computeCost,
    total_cost: Number((llmCost + computeCost).toFixed(10)),
    request_count: numberValue(llmTotals?.requestCount),
    compute_seconds: numberValue(computeTotals?.computeSeconds),
    // The larger of the two sources' distinct session counts — NOT the true
    // union: a session with LLM-only spend and a different session with
    // compute-only spend both go uncounted by Math.max the same way they
    // would under- or over-count with either side alone. This follows
    // mergeWorkspaceCostRows's established convention above (same
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
    // project on BYO keys with no gateway rows at all), and listCostByWorkspace
    // above already treats such a project as real (mergeWorkspaceCostRows's
    // compute loop calls ensure(row.workspaceId) same as the LLM loop). This is
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
    models: modelRows.map((row) => ({
      provider: row.provider,
      model: row.model,
      cost: numberValue(row.cost),
      request_count: numberValue(row.requestCount),
    })),
  };
}
