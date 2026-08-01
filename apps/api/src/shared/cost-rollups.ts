import { gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { CostSort, CostWindow } from './cost-window';
import { db } from './db';

export interface ProjectCostRow {
  project_id: string;
  project_name: string;
  session_count: number;
  llm_cost: number;
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
  sessionCount: number | string;
  lastAt: Date | string | null;
}

interface ComputeProjectAggregateRow {
  projectId: string | null;
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
      .where(eq(projects.accountId, accountId)),
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
