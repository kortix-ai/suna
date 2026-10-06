import { gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { isoValue, numberValue } from './cost-values';

import type { CostSort, CostWindow } from './cost-window';
import { db } from './db';
import {
  kortixBilledSpendSql,
  providerBilledSpendSql,
  rowKortixBilledSpendSql,
  rowProviderBilledSpendSql,
} from './llm-spend';
import { billedComputeSecondsExpression } from './session-costs';
import { ttlMemo } from './ttl-memo';

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

// LLM rows carry project_id directly (idx_gateway_logs_account_time). Compute
// rows do not: they reach project_id by joining project_sessions, whose
// session_id is the primary key — a PK join, not a scan.
//
// Both aggregates group by (project_id, session_id) rather than project_id
// alone, so the per-project session count is a row count in JS instead of a
// `count(distinct session_id)`. A distinct aggregate inside a grouped query
// makes Postgres sort the account's whole window by (project_id,
// session_id) — measured at ~340 ms for 200 k rows, the slowest statement on
// this surface — while the hashable pair grouping costs ~140 ms and never
// sorts. collapseProjectPairRows folds the pairs back into one row per
// project for mergeProjectCostRows.

interface LlmProjectPairRow {
  // The WHERE excludes NULL project ids, but Drizzle's column type stays
  // nullable — the collapse skips the nulls the type cannot rule out.
  projectId: string | null;
  sessionId: string | null;
  llmCost: number | string;
  llmProviderCost: number | string;
  lastAt: Date | string | null;
}

interface ComputeProjectPairRow {
  projectId: string | null;
  sessionId: string | null;
  computeCost: number | string;
  lastAt: string | null;
}

// Pair rows → the per-project aggregate rows mergeProjectCostRows consumes.
// A project's session count is its distinct non-null session ids (a NULL
// session spends money but names no session); its spend is the sum of the
// pair sums; its last activity is the latest pair max.
export function collapseProjectPairRows(
  llmPairs: LlmProjectPairRow[],
  computePairs: ComputeProjectPairRow[],
): { llm: LlmProjectAggregateRow[]; compute: ComputeProjectAggregateRow[] } {
  interface PairEntry {
    llmCost: number;
    llmProviderCost: number;
    computeCost: number;
    // Per-source session sets: mergeProjectCostRows takes the LARGER of the
    // two sources' distinct session counts for a project, not their union —
    // one session with LLM-only spend and another with compute-only spend
    // count once each side, so Math.max picks 1, the same number the old
    // count(distinct) aggregates reported.
    llmSessions: Set<string>;
    computeSessions: Set<string>;
    lastAt: string | null;
  }
  const entries = new Map<string, PairEntry>();
  const entryOf = (projectId: string): PairEntry => {
    const existing = entries.get(projectId);
    if (existing) return existing;
    const created: PairEntry = {
      llmCost: 0,
      llmProviderCost: 0,
      computeCost: 0,
      llmSessions: new Set<string>(),
      computeSessions: new Set<string>(),
      lastAt: null,
    };
    entries.set(projectId, created);
    return created;
  };

  const llmProjects = new Set<string>();
  const computeProjects = new Set<string>();
  for (const row of llmPairs) {
    if (!row.projectId) continue;
    const entry = entryOf(row.projectId);
    llmProjects.add(row.projectId);
    entry.llmCost = Number((entry.llmCost + numberValue(row.llmCost)).toFixed(10));
    entry.llmProviderCost = Number(
      (entry.llmProviderCost + numberValue(row.llmProviderCost)).toFixed(10),
    );
    if (row.sessionId) entry.llmSessions.add(row.sessionId);
    entry.lastAt = laterIso(entry.lastAt, isoValue(row.lastAt));
  }
  for (const row of computePairs) {
    if (!row.projectId) continue;
    const entry = entryOf(row.projectId);
    computeProjects.add(row.projectId);
    entry.computeCost = Number((entry.computeCost + numberValue(row.computeCost)).toFixed(10));
    if (row.sessionId) entry.computeSessions.add(row.sessionId);
    entry.lastAt = laterIso(entry.lastAt, isoValue(row.lastAt));
  }

  // A project with only one source's pairs appears only in that source's
  // list — mergeProjectCostRows creates the zero-cost side itself.
  const llm: LlmProjectAggregateRow[] = [];
  const compute: ComputeProjectAggregateRow[] = [];
  for (const [projectId, entry] of entries) {
    if (llmProjects.has(projectId)) {
      llm.push({
        projectId,
        llmCost: entry.llmCost,
        llmKortixCost: entry.llmCost,
        llmProviderCost: entry.llmProviderCost,
        sessionCount: entry.llmSessions.size,
        lastAt: entry.lastAt,
      });
    }
    if (computeProjects.has(projectId)) {
      compute.push({
        projectId,
        computeCost: entry.computeCost,
        sessionCount: entry.computeSessions.size,
        lastAt: entry.lastAt,
      });
    }
  }
  return { llm, compute };
}

export function listCostByProject(input: CostByProjectInput): Promise<ProjectCostPage> {
  return costByProjectMemo(input);
}

async function loadCostByProject(input: CostByProjectInput): Promise<ProjectCostPage> {
  const { accountId, window } = input;

  const [llmPairs, computePairs, projectRows] = await Promise.all([
    db
      .select({
        projectId: gatewayRequestLogs.projectId,
        sessionId: gatewayRequestLogs.sessionId,
        llmCost: kortixBilledSpendSql,
        llmProviderCost: providerBilledSpendSql,
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
      .groupBy(gatewayRequestLogs.projectId, gatewayRequestLogs.sessionId),
    db
      .select({
        projectId: projectSessions.projectId,
        sessionId: sandboxComputeSessions.sessionId,
        computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
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
      .groupBy(projectSessions.projectId, sandboxComputeSessions.sessionId),
    db
      .select({ projectId: projects.projectId, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.accountId, accountId),
          input.projectId ? eq(projects.projectId, input.projectId) : undefined,
        ),
      ),
  ]);

  const projectNames = new Map(projectRows.map((row) => [row.projectId, row.name]));
  const { llm, compute } = collapseProjectPairRows(llmPairs, computePairs);
  const merged = sortProjectRows(mergeProjectCostRows(llm, compute, projectNames), input.sort);

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

// ── Response cache ─────────────────────────────────────────────────────────
// Both cost rollups are full-window scans of two append-only tables; on a
// busy account each response costs hundreds of ms of database work. The
// explorer refetches whenever a visit is older than the client's 30 s
// staleTime, so most loads repeat a recent computation. A small per-process
// TTL memo turns those into a cache hit — and collapses concurrent duplicate
// loads into one in-flight computation. Spend rows are insert-only and the
// windows are analytics-scale, so a 60 s-old aggregate stays inside the
// staleness the client already accepts. The key is the full resolved input —
// the accountId is derived from the caller's token before this point, so
// entries are never shared across accounts.
const COST_CACHE_TTL_MS = 60_000;

/** The scope inputs `getCostSummary` aggregates over. */
export interface CostSummaryInput {
  accountId: string;
  projectId?: string;
  sessionId?: string;
  window: CostWindow;
}

/** The scope inputs `listCostByProject` aggregates over. */
export interface CostByProjectInput {
  accountId: string;
  projectId?: string;
  window: CostWindow;
  sort: CostSort;
  limit: number;
  offset: number;
}

// replica-local: per-instance memo, deliberately not shared across replicas
const costSummaryMemo = ttlMemo({
  ttlMs: COST_CACHE_TTL_MS,
  maxEntries: 500,
  enableInTests: true,
  keyFn: (input: CostSummaryInput) =>
    `summary:${JSON.stringify({
      accountId: input.accountId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
    })}`,
  loader: (input) => loadCostSummary(input),
});

// replica-local: per-instance memo, deliberately not shared across replicas
const costByProjectMemo = ttlMemo({
  ttlMs: COST_CACHE_TTL_MS,
  maxEntries: 500,
  enableInTests: true,
  keyFn: (input: CostByProjectInput) =>
    `by-project:${JSON.stringify({
      accountId: input.accountId,
      projectId: input.projectId ?? null,
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
      sort: input.sort,
      limit: input.limit,
      offset: input.offset,
    })}`,
  loader: (input) => loadCostByProject(input),
});

/** Drops every cached cost response — the test seam for deterministic suites. */
export function resetCostCaches(): void {
  costSummaryMemo.clear();
  costByProjectMemo.clear();
}

// ── Summary ────────────────────────────────────────────────────────────────
// The account's whole spend picture — totals, daily series, model breakdown,
// prior-window delta, project count — used to be nine separate windowed
// queries, six of them full scans of gateway_request_logs, and the totals
// carried a `count(distinct session_id)`, which Postgres answers by sorting
// the account's entire window (measured ~340 ms for 200 k rows: the single
// slowest statement on this surface). This shape runs seven queries and
// sorts nothing:
//
//   1. LLM totals + prior total — one filtered aggregate over the combined
//      [previous.from, to) range; FILTER bounds inside the aggregates split
//      current from prior, so both windows ride one index-range scan.
//   2. LLM session/project pairs — GROUP BY on two raw columns (hash, never
//      a sort) yields the distinct-session count and the distinct-project
//      list in one pass.
//   3. LLM daily series — unchanged.
//   4. LLM top-10 models — unchanged (ORDER BY + LIMIT stays in SQL).
//   5. Compute totals + prior — as (1), on sandbox_compute_sessions.
//   6. Compute daily series — unchanged.
//   7. Compute project ids — unchanged.
//
// The compute queries all LEFT JOIN project_sessions (session_id is its
// primary key, so the join never duplicates a compute row): unscoped, the
// join must not filter anything, because an inner join would drop compute
// cost from sessions with no project_sessions row and undercount the
// account-wide total the "unassigned" row depends on; scoped, the WHERE on
// the joined column narrows the join to exactly the inner-join rows the
// scoped totals always covered.

const LLM_DAY_EXPRESSION = sql<string>`to_char(date_trunc('day', ${gatewayRequestLogs.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
// UTC day bucket for the compute daily series, keyed off started_at. The
// underlying column is timestamptz regardless of the client-side string
// mode, so `at time zone 'UTC'` on the raw column is valid the same way.
const COMPUTE_DAY_EXPRESSION = sql<string>`to_char(date_trunc('day', ${sandboxComputeSessions.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

export function getCostSummary(input: CostSummaryInput): Promise<CostSummary> {
  return costSummaryMemo(input);
}

async function loadCostSummary(input: CostSummaryInput): Promise<CostSummary> {
  const { accountId, projectId, sessionId, window } = input;
  const previous = previousWindow(window);

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

  const llmInWindow = sql`${gatewayRequestLogs.createdAt} >= ${window.from.toISOString()}::timestamptz`;
  const llmInPrior = sql`${gatewayRequestLogs.createdAt} < ${window.from.toISOString()}::timestamptz`;

  // Compute rows carry no project_id of their own; the LEFT JOIN reaches it
  // through project_sessions. See the section comment for why the join is
  // unconditional and why scoping filters on the joined column.
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
  const computeInWindow = sql`${sandboxComputeSessions.startedAt} >= ${window.from.toISOString()}::timestamptz`;
  const computeInPrior = sql`${sandboxComputeSessions.startedAt} < ${window.from.toISOString()}::timestamptz`;

  const [
    llmTotalsRows,
    llmPairRows,
    llmDailyRows,
    modelRows,
    computeTotalsRows,
    computeDailyRows,
    computeProjectIdRows,
  ] = await Promise.all([
    db
      .select({
        requests: sql<number>`count(*) filter (where ${llmInWindow})::int`,
        kortixCost: sql<number>`coalesce(sum(${rowKortixBilledSpendSql}) filter (where ${llmInWindow}), 0)::float8`,
        providerCost: sql<number>`coalesce(sum(${rowProviderBilledSpendSql}) filter (where ${llmInWindow}), 0)::float8`,
        priorCost: sql<number>`coalesce(sum(${rowKortixBilledSpendSql}) filter (where ${llmInPrior}), 0)::float8`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope({ from: previous.from, to: window.to })),
    db
      .select({ sessionId: gatewayRequestLogs.sessionId, projectId: gatewayRequestLogs.projectId })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(gatewayRequestLogs.sessionId, gatewayRequestLogs.projectId),
    db
      .select({
        day: LLM_DAY_EXPRESSION,
        cost: kortixBilledSpendSql,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(LLM_DAY_EXPRESSION),
    db
      .select({
        provider: gatewayRequestLogs.provider,
        model: gatewayRequestLogs.resolvedModel,
        cost: kortixBilledSpendSql,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(gatewayRequestLogs)
      .where(llmScope(window))
      .groupBy(gatewayRequestLogs.provider, gatewayRequestLogs.resolvedModel)
      // Cost descending, then provider/model descending as a deterministic
      // tie-break — without it, which model lands on the 10th row of a tie
      // is unspecified and can flip between refreshes.
      .orderBy(
        desc(kortixBilledSpendSql),
        desc(gatewayRequestLogs.provider),
        desc(gatewayRequestLogs.resolvedModel),
      )
      .limit(10),
    db
      .select({
        computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}) filter (where ${computeInWindow}), 0)::float8`,
        computeSeconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}) filter (where ${computeInWindow}), 0)::float8`,
        sessionCount: sql<number>`count(distinct ${sandboxComputeSessions.sessionId}) filter (where ${computeInWindow})::int`,
        priorCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}) filter (where ${computeInPrior}), 0)::float8`,
      })
      .from(sandboxComputeSessions)
      .leftJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(computeScope({ from: previous.from, to: window.to })),
    db
      .select({
        day: COMPUTE_DAY_EXPRESSION,
        cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
      })
      .from(sandboxComputeSessions)
      .leftJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(computeScope(window))
      .groupBy(COMPUTE_DAY_EXPRESSION),
    db
      .select({ projectId: projectSessions.projectId })
      .from(sandboxComputeSessions)
      .leftJoin(projectSessions, eq(projectSessions.sessionId, sandboxComputeSessions.sessionId))
      .where(computeScope(window))
      .groupBy(projectSessions.projectId),
  ]);

  // Distinct LLM sessions and projects off the pair rows: a NULL session_id
  // or project_id spends real money (the totals above count it) but names no
  // session or project, so it joins neither set.
  const llmSessionIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const row of llmPairRows) {
    if (row.sessionId) llmSessionIds.add(row.sessionId);
    if (row.projectId) projectIds.add(row.projectId);
  }
  for (const row of computeProjectIdRows) if (row.projectId) projectIds.add(row.projectId);

  const llmTotals = llmTotalsRows[0];
  const computeTotals = computeTotalsRows[0];
  const llmCost = numberValue(llmTotals?.kortixCost);
  const computeCost = numberValue(computeTotals?.computeCost);

  const totals: CostSummaryTotals = {
    llm_cost: llmCost,
    // Alias of llm_cost, retained for the additive payee breakdown — both
    // read the same aggregate off the totals row.
    llm_kortix_cost: llmCost,
    llm_provider_cost: numberValue(llmTotals?.providerCost),
    compute_cost: computeCost,
    total_cost: Number((llmCost + computeCost).toFixed(10)),
    request_count: numberValue(llmTotals?.requests),
    compute_seconds: numberValue(computeTotals?.computeSeconds),
    // The larger of the two sources' distinct session counts — NOT the true
    // union: a session with LLM-only spend and a different session with
    // compute-only spend both go uncounted by Math.max the same way they
    // would under- or over-count with either side alone. This follows
    // mergeProjectCostRows's established convention rather than diverging
    // with a more accurate but novel calculation.
    session_count: Math.max(llmSessionIds.size, numberValue(computeTotals?.sessionCount)),
    // The true union of distinct project ids across both sources: a project
    // can have compute spend and zero gateway_request_logs rows in the window
    // (a session whose compute started inside the window but whose LLM calls
    // fell outside it, or a project on BYO keys with no gateway rows at all),
    // and listCostByProject above already treats such a project as real.
    project_count: projectIds.size,
  };

  return {
    totals,
    previous: {
      total_cost: Number(
        (numberValue(llmTotals?.priorCost) + numberValue(computeTotals?.priorCost)).toFixed(10),
      ),
    },
    series: buildCostSeries(llmDailyRows, computeDailyRows, window),
    models: modelRows.map((row) => ({
      provider: row.provider,
      model: row.model,
      cost: numberValue(row.cost),
      request_count: numberValue(row.requestCount),
    })),
  };
}
