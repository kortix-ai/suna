import {
  gatewayRequestLogs,
  projectSessions,
  projects,
  sandboxComputeSessions,
  sessionSandboxes,
} from '@kortix/db';
import {
  type SQL,
  type SQLWrapper,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import { resolveSessionOwnerIdentities } from '../projects/lib/access';
import type { SessionOwnerIdentity } from '../projects/lib/session-inventory';
import type { CostSort, CostWindow } from './cost-window';
import { db } from './db';

type NumericValue = number | string | null | undefined;
type TemporalValue = Date | string | null | undefined;
type ProjectSessionStatus = typeof projectSessions.$inferSelect.status;

export class InvalidSessionCostQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionCostQueryError';
  }
}

export interface SessionCostSummary {
  session_id: string;
  project_id: string;
  project_name: string;
  owner_id: string | null;
  owner_type: 'user' | 'service_account' | 'unknown' | null;
  owner_name: string | null;
  owner_email: string | null;
  status: ProjectSessionStatus;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  model_count: number;
  compute_seconds: number;
}

export interface SessionCostModelUsage {
  provider: string;
  model: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost: number;
  last_at: string;
}

export interface SessionCostLlmLedgerEntry {
  kind: 'llm';
  id: string;
  occurred_at: string;
  cost: number;
  provider: string;
  model: string;
  request_id: string;
  status: number;
  ok: boolean;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
}

export interface SessionCostComputeLedgerEntry {
  kind: 'compute';
  id: string;
  started_at: string;
  ended_at: string | null;
  billed_through_at: string;
  cost: number;
  provider: string;
  state: string;
  compute_seconds: number;
  cpu_cores: number;
  memory_gb: number;
  disk_gb: number;
  gpu_count: number;
}

export type SessionCostLedgerEntry = SessionCostLlmLedgerEntry | SessionCostComputeLedgerEntry;

export interface SessionCostDetail extends SessionCostSummary {
  model_usage: SessionCostModelUsage[];
  ledger_entries: SessionCostLedgerEntry[];
}

export interface SessionCostReconciliation {
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  request_count: number;
  compute_window_count: number;
  compute_seconds: number;
}

export interface SessionCostListResponse {
  sessions: SessionCostSummary[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  reconciliation: SessionCostReconciliation;
}

interface SessionBaseRow {
  sessionId: string;
  projectId: string;
  projectName: string;
  ownerId: string | null;
  status: ProjectSessionStatus;
  createdAt: TemporalValue;
  updatedAt: TemporalValue;
}

interface LlmAggregateRow {
  sessionId?: string | null;
  llmCost: NumericValue;
  requestCount: NumericValue;
  errorCount: NumericValue;
  inputTokens: NumericValue;
  outputTokens: NumericValue;
  cachedTokens: NumericValue;
  cacheWriteTokens: NumericValue;
  modelCount: NumericValue;
  lastAt: TemporalValue;
}

interface ComputeAggregateRow {
  sessionId?: string | null;
  computeCost: NumericValue;
  computeSeconds: NumericValue;
  lastAt: TemporalValue;
}

interface LegacyLlmAggregateRow {
  sessionId: string | null;
  requests: NumericValue;
  errors: NumericValue;
  cost: NumericValue;
  tokens: NumericValue;
  models: NumericValue;
  lastAt: TemporalValue;
}

interface LegacyComputeAggregateRow {
  sessionId: string | null;
  cost: NumericValue;
  seconds: NumericValue;
  lastAt: TemporalValue;
}

export interface LegacyGatewaySessionRow {
  session_id: string;
  llm_cost: number;
  compute_cost: number;
  requests: number;
  errors: number;
  tokens: number;
  models: number;
  compute_seconds: number;
  last_at: string | null;
  total_cost: number;
}

const billedComputeSecondsExpression = sql<number>`
  greatest(
    extract(
      epoch from ${sandboxComputeSessions.lastBilledAt} - ${sandboxComputeSessions.startedAt}
    ),
    0
  )
`;

function numberValue(value: NumericValue): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function sumCosts(left: number, right: number): number {
  return Number((left + right).toFixed(10));
}

function isoValue(value: TemporalValue): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIsoValue(value: TemporalValue): string {
  return isoValue(value) ?? new Date(0).toISOString();
}

function latestIsoValue(...values: TemporalValue[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    const candidate = isoValue(value);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

export function computeBilledSeconds(
  startedAt: TemporalValue,
  billedThroughAt: TemporalValue,
): number {
  const started = isoValue(startedAt);
  const billedThrough = isoValue(billedThroughAt);
  if (!started || !billedThrough) return 0;
  return Math.max(0, (new Date(billedThrough).getTime() - new Date(started).getTime()) / 1000);
}

export function assembleSessionCostSummary(input: {
  session: SessionBaseRow;
  owner?: SessionOwnerIdentity;
  llm?: LlmAggregateRow;
  compute?: ComputeAggregateRow;
}): SessionCostSummary {
  const llmCost = numberValue(input.llm?.llmCost);
  const computeCost = numberValue(input.compute?.computeCost);
  const ownerType = input.session.ownerId ? (input.owner?.type ?? 'unknown') : null;

  return {
    session_id: input.session.sessionId,
    project_id: input.session.projectId,
    project_name: input.session.projectName,
    owner_id: input.session.ownerId,
    owner_type: ownerType,
    owner_name: input.owner?.name ?? null,
    owner_email: input.owner?.email ?? null,
    status: input.session.status,
    created_at: requiredIsoValue(input.session.createdAt),
    updated_at: requiredIsoValue(input.session.updatedAt),
    last_activity_at: latestIsoValue(input.llm?.lastAt, input.compute?.lastAt),
    llm_cost: llmCost,
    compute_cost: computeCost,
    total_cost: sumCosts(llmCost, computeCost),
    request_count: numberValue(input.llm?.requestCount),
    error_count: numberValue(input.llm?.errorCount),
    input_tokens: numberValue(input.llm?.inputTokens),
    output_tokens: numberValue(input.llm?.outputTokens),
    cached_tokens: numberValue(input.llm?.cachedTokens),
    cache_write_tokens: numberValue(input.llm?.cacheWriteTokens),
    model_count: numberValue(input.llm?.modelCount),
    compute_seconds: numberValue(input.compute?.computeSeconds),
  };
}

function ledgerEntryTime(entry: SessionCostLedgerEntry): string {
  return entry.kind === 'llm' ? entry.occurred_at : entry.billed_through_at;
}

export function sortLedgerEntriesNewestFirst(
  entries: SessionCostLedgerEntry[],
): SessionCostLedgerEntry[] {
  return [...entries].sort((left, right) => {
    const byTime = ledgerEntryTime(right).localeCompare(ledgerEntryTime(left));
    return byTime || right.id.localeCompare(left.id);
  });
}

export function mergeLegacyGatewaySessionRows(
  llmRows: LegacyLlmAggregateRow[],
  computeRows: LegacyComputeAggregateRow[],
): LegacyGatewaySessionRow[] {
  const bySession = new Map<string, Omit<LegacyGatewaySessionRow, 'total_cost'>>();

  for (const row of llmRows) {
    if (!row.sessionId) continue;
    bySession.set(row.sessionId, {
      session_id: row.sessionId,
      llm_cost: numberValue(row.cost),
      compute_cost: 0,
      requests: numberValue(row.requests),
      errors: numberValue(row.errors),
      tokens: numberValue(row.tokens),
      models: numberValue(row.models),
      compute_seconds: 0,
      last_at: isoValue(row.lastAt),
    });
  }

  for (const row of computeRows) {
    if (!row.sessionId) continue;
    const existing = bySession.get(row.sessionId) ?? {
      session_id: row.sessionId,
      llm_cost: 0,
      compute_cost: 0,
      requests: 0,
      errors: 0,
      tokens: 0,
      models: 0,
      compute_seconds: 0,
      last_at: null,
    };
    existing.compute_cost = numberValue(row.cost);
    existing.compute_seconds = numberValue(row.seconds);
    existing.last_at = latestIsoValue(existing.last_at, row.lastAt);
    bySession.set(row.sessionId, existing);
  }

  return [...bySession.values()]
    .map((row) => ({
      ...row,
      total_cost: sumCosts(row.llm_cost, row.compute_cost),
    }))
    .sort((left, right) => right.total_cost - left.total_cost)
    .slice(0, 50);
}

// The LLM aggregate columns, shared by the windowed subquery that feeds the
// session list and the all-time scalar query that feeds the session detail.
const llmAggregateFields = {
  llmCost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
  requestCount: sql<number>`count(*)::int`,
  errorCount: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
  inputTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens}), 0)::float8`,
  outputTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.outputTokens}), 0)::float8`,
  cachedTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.cachedTokens}), 0)::float8`,
  cacheWriteTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.cacheWriteTokens}), 0)::float8`,
  modelCount: sql<number>`count(distinct (${gatewayRequestLogs.provider}, ${gatewayRequestLogs.resolvedModel}))::int`,
  lastAt: sql<Date | null>`max(${gatewayRequestLogs.createdAt})`,
};

const computeAggregateFields = {
  computeCost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
  computeSeconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}), 0)::float8`,
  lastAt: sql<string | null>`max(${sandboxComputeSessions.lastBilledAt})`,
};

// Windowed LLM aggregate, grouped per session so the caller can join it to a
// page of sessions and let Postgres order by spend. Anchored on created_at,
// which idx_gateway_logs_account_time covers. Money stays numeric through the
// sum and is cast to float8 only for transport.
function llmAggregateSubquery(accountId: string, window: CostWindow) {
  return db
    .select({
      sessionId: gatewayRequestLogs.sessionId,
      llmCost: llmAggregateFields.llmCost.as('llm_cost'),
      requestCount: llmAggregateFields.requestCount.as('request_count'),
      errorCount: llmAggregateFields.errorCount.as('error_count'),
      inputTokens: llmAggregateFields.inputTokens.as('input_tokens'),
      outputTokens: llmAggregateFields.outputTokens.as('output_tokens'),
      cachedTokens: llmAggregateFields.cachedTokens.as('cached_tokens'),
      cacheWriteTokens: llmAggregateFields.cacheWriteTokens.as('cache_write_tokens'),
      modelCount: llmAggregateFields.modelCount.as('model_count'),
      lastAt: llmAggregateFields.lastAt.as('last_at'),
    })
    .from(gatewayRequestLogs)
    .where(
      and(
        eq(gatewayRequestLogs.accountId, accountId),
        // createdAt is a Date-mode timestamp, so the bounds are Date objects.
        gte(gatewayRequestLogs.createdAt, window.from),
        lt(gatewayRequestLogs.createdAt, window.to),
        sql`${gatewayRequestLogs.sessionId} is not null`,
      ),
    )
    .groupBy(gatewayRequestLogs.sessionId)
    .as('llm_agg');
}

// Windowed compute aggregate, anchored on started_at because that is the column
// idx_sandbox_compute_sessions_account_time covers. last_billed_at's only index
// is partial (WHERE state = 'active') and exists for the biller, not reporting.
function computeAggregateSubquery(accountId: string, window: CostWindow) {
  return db
    .select({
      sessionId: sandboxComputeSessions.sessionId,
      computeCost: computeAggregateFields.computeCost.as('compute_cost'),
      computeSeconds: computeAggregateFields.computeSeconds.as('compute_seconds'),
      lastAt: computeAggregateFields.lastAt.as('last_at'),
    })
    .from(sandboxComputeSessions)
    .where(
      and(
        eq(sandboxComputeSessions.accountId, accountId),
        // startedAt is declared mode:'string', so the bounds are ISO strings.
        gte(sandboxComputeSessions.startedAt, window.from.toISOString()),
        lt(sandboxComputeSessions.startedAt, window.to.toISOString()),
        sql`${sandboxComputeSessions.sessionId} is not null`,
      ),
    )
    .groupBy(sandboxComputeSessions.sessionId)
    .as('compute_agg');
}

// All-time totals for one session. The detail view is an audit surface: it must
// reconcile against the ledger entries listed beside it, which are unwindowed.
// No GROUP BY, so both queries always return exactly one row.
async function loadSessionTotals(
  accountId: string,
  sessionId: string,
): Promise<{ llm: LlmAggregateRow | undefined; compute: ComputeAggregateRow | undefined }> {
  const [llmRows, computeRows] = await Promise.all([
    db
      .select(llmAggregateFields)
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, accountId),
          eq(gatewayRequestLogs.sessionId, sessionId),
        ),
      ),
    db
      .select(computeAggregateFields)
      .from(sandboxComputeSessions)
      .where(
        and(
          eq(sandboxComputeSessions.accountId, accountId),
          eq(sandboxComputeSessions.sessionId, sessionId),
        ),
      ),
  ]);

  return { llm: llmRows[0], compute: computeRows[0] };
}

async function loadReconciliation(
  accountId: string,
  window: CostWindow,
  projectId?: string,
): Promise<SessionCostReconciliation> {
  // The unassigned-cost figure has to describe the same period as the table it
  // sits beside, so it carries the caller's window on the same columns the
  // per-session aggregates use.
  const llmConditions: SQL[] = [
    eq(gatewayRequestLogs.accountId, accountId),
    isNull(projectSessions.sessionId),
    gte(gatewayRequestLogs.createdAt, window.from),
    lt(gatewayRequestLogs.createdAt, window.to),
  ];
  if (projectId) llmConditions.push(eq(gatewayRequestLogs.projectId, projectId));

  const computeConditions: SQL[] = [
    eq(sandboxComputeSessions.accountId, accountId),
    isNull(projectSessions.sessionId),
    gte(sandboxComputeSessions.startedAt, window.from.toISOString()),
    lt(sandboxComputeSessions.startedAt, window.to.toISOString()),
  ];
  if (projectId) computeConditions.push(eq(sessionSandboxes.projectId, projectId));

  const [llmResult, computeResult] = await Promise.all([
    db
      .select({
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        requests: sql<number>`count(*)::int`,
      })
      .from(gatewayRequestLogs)
      .leftJoin(
        projectSessions,
        and(
          eq(projectSessions.accountId, gatewayRequestLogs.accountId),
          eq(projectSessions.sessionId, gatewayRequestLogs.sessionId),
        ),
      )
      .where(and(...llmConditions)),
    db
      .select({
        cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        windows: sql<number>`count(*)::int`,
        seconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}), 0)::float8`,
      })
      .from(sandboxComputeSessions)
      .leftJoin(
        projectSessions,
        and(
          eq(projectSessions.accountId, sandboxComputeSessions.accountId),
          eq(projectSessions.sessionId, sandboxComputeSessions.sessionId),
        ),
      )
      .leftJoin(
        sessionSandboxes,
        and(
          eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId),
          eq(sessionSandboxes.accountId, sandboxComputeSessions.accountId),
        ),
      )
      .where(and(...computeConditions)),
  ]);

  const llmCost = numberValue(llmResult[0]?.cost);
  const computeCost = numberValue(computeResult[0]?.cost);
  return {
    llm_cost: llmCost,
    compute_cost: computeCost,
    total_cost: sumCosts(llmCost, computeCost),
    request_count: numberValue(llmResult[0]?.requests),
    compute_window_count: numberValue(computeResult[0]?.windows),
    compute_seconds: numberValue(computeResult[0]?.seconds),
  };
}

interface SortableCostRow {
  session_id: string;
  total_cost: number;
  updated_at: string;
}

// The only columns a session cost page can be ordered by. Widening this union
// forces a compile error at every exhaustive map below.
type SessionCostSortColumn = 'total_cost' | 'updated_at';

// Exhaustive on purpose. `CostSort` is shared with the project rollup, which
// has a `name_asc` sessions cannot honor, and later work may add members. A
// fall-through here would compile into silently wrong ordering.
export function sessionCostSortKey(sort: CostSort): [SessionCostSortColumn, 'asc' | 'desc'] {
  switch (sort) {
    case 'recent':
      return ['updated_at', 'desc'];
    case 'total_asc':
      return ['total_cost', 'asc'];
    case 'total_desc':
      return ['total_cost', 'desc'];
    case 'name_asc':
      throw new InvalidSessionCostQueryError('sessions cannot be sorted by name');
    default: {
      const unsupported: never = sort;
      throw new InvalidSessionCostQueryError(`unsupported sort: ${String(unsupported)}`);
    }
  }
}

const compareByColumn: Record<
  SessionCostSortColumn,
  (left: SortableCostRow, right: SortableCostRow) => number
> = {
  total_cost: (left, right) => left.total_cost - right.total_cost,
  updated_at: (left, right) => left.updated_at.localeCompare(right.updated_at),
};

// The JS mirror of the ORDER BY, derived from the same key so the two cannot
// drift. Ties break on session_id so LIMIT/OFFSET paging is stable: without a
// total order, a row can appear on two pages or on none.
export function compareSessionCostRows(sort: CostSort) {
  const [column, direction] = sessionCostSortKey(sort);
  return (left: SortableCostRow, right: SortableCostRow): number => {
    const delta = compareByColumn[column](left, right);
    const ordered = direction === 'asc' ? delta : -delta;
    return ordered || left.session_id.localeCompare(right.session_id);
  };
}

export async function listSessionCosts(input: {
  accountId: string;
  projectId?: string;
  ownerId?: string;
  window: CostWindow;
  sort: CostSort;
  limit: number;
  offset: number;
}): Promise<SessionCostListResponse> {
  // Required, not defaulted: GET /v1/usage/session-costs (the sole caller) always
  // parses both from the request and passes them explicitly. A caller that omits
  // either fails to compile, so a new caller cannot silently inherit a default it
  // never chose.
  const { window, sort } = input;

  const llm = llmAggregateSubquery(input.accountId, window);
  const compute = computeAggregateSubquery(input.accountId, window);

  const conditions: SQL[] = [eq(projectSessions.accountId, input.accountId)];
  if (input.projectId) conditions.push(eq(projectSessions.projectId, input.projectId));
  if (input.ownerId) conditions.push(eq(projectSessions.createdBy, input.ownerId));

  const totalCostExpression = sql<number>`(coalesce(${llm.llmCost}, 0) + coalesce(${compute.computeCost}, 0))`;
  const sortTargets: Record<SessionCostSortColumn, SQLWrapper> = {
    total_cost: totalCostExpression,
    updated_at: projectSessions.updatedAt,
  };
  const [sortColumn, sortDirection] = sessionCostSortKey(sort);
  const sortTarget = sortTargets[sortColumn];
  const orderBy = [
    sortDirection === 'asc' ? asc(sortTarget) : desc(sortTarget),
    asc(projectSessions.sessionId),
  ];

  const [sessionRows, totalRows, reconciliation] = await Promise.all([
    db
      .select({
        sessionId: projectSessions.sessionId,
        projectId: projectSessions.projectId,
        projectName: projects.name,
        ownerId: projectSessions.createdBy,
        status: projectSessions.status,
        createdAt: projectSessions.createdAt,
        updatedAt: projectSessions.updatedAt,
        llmCost: llm.llmCost,
        requestCount: llm.requestCount,
        errorCount: llm.errorCount,
        inputTokens: llm.inputTokens,
        outputTokens: llm.outputTokens,
        cachedTokens: llm.cachedTokens,
        cacheWriteTokens: llm.cacheWriteTokens,
        modelCount: llm.modelCount,
        llmLastAt: llm.lastAt,
        computeCost: compute.computeCost,
        computeSeconds: compute.computeSeconds,
        computeLastAt: compute.lastAt,
      })
      .from(projectSessions)
      .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
      .leftJoin(llm, eq(llm.sessionId, projectSessions.sessionId))
      .leftJoin(compute, eq(compute.sessionId, projectSessions.sessionId))
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ total: count() })
      .from(projectSessions)
      .where(and(...conditions)),
    loadReconciliation(input.accountId, window, input.projectId),
  ]);

  const ownerIds = sessionRows
    .map((row) => row.ownerId)
    .filter((ownerId): ownerId is string => Boolean(ownerId));
  const ownerById = await resolveSessionOwnerIdentities(ownerIds, input.accountId);

  const total = numberValue(totalRows[0]?.total);
  // Postgres is the sole authority on order. Re-sorting here would be a second,
  // divergent statement of it: `updated_at` loses sub-millisecond precision
  // through requiredIsoValue, and sumCosts rounds to 10 decimal places, so a
  // JS pass can reorder rows the query deliberately separated.
  const sessions = sessionRows.map((row) =>
    assembleSessionCostSummary({
      session: row,
      owner: row.ownerId ? ownerById.get(row.ownerId) : undefined,
      llm: {
        llmCost: row.llmCost,
        requestCount: row.requestCount,
        errorCount: row.errorCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        modelCount: row.modelCount,
        lastAt: row.llmLastAt,
      },
      compute: {
        computeCost: row.computeCost,
        computeSeconds: row.computeSeconds,
        lastAt: row.computeLastAt,
      },
    }),
  );

  return {
    sessions,
    total,
    limit: input.limit,
    offset: input.offset,
    next_offset:
      input.offset + sessionRows.length < total ? input.offset + sessionRows.length : null,
    reconciliation,
  };
}

async function loadModelUsage(
  accountId: string,
  sessionId: string,
): Promise<SessionCostModelUsage[]> {
  const rows = await db
    .select({
      provider: gatewayRequestLogs.provider,
      model: gatewayRequestLogs.resolvedModel,
      requestCount: sql<number>`count(*)::int`,
      errorCount: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
      inputTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.outputTokens}), 0)::float8`,
      cachedTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.cachedTokens}), 0)::float8`,
      cacheWriteTokens: sql<number>`coalesce(sum(${gatewayRequestLogs.cacheWriteTokens}), 0)::float8`,
      cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
      lastAt: sql<Date>`max(${gatewayRequestLogs.createdAt})`,
    })
    .from(gatewayRequestLogs)
    .where(
      and(eq(gatewayRequestLogs.accountId, accountId), eq(gatewayRequestLogs.sessionId, sessionId)),
    )
    .groupBy(gatewayRequestLogs.provider, gatewayRequestLogs.resolvedModel)
    .orderBy(desc(sql`sum(${gatewayRequestLogs.finalCost})`));

  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    request_count: numberValue(row.requestCount),
    error_count: numberValue(row.errorCount),
    input_tokens: numberValue(row.inputTokens),
    output_tokens: numberValue(row.outputTokens),
    cached_tokens: numberValue(row.cachedTokens),
    cache_write_tokens: numberValue(row.cacheWriteTokens),
    cost: numberValue(row.cost),
    last_at: requiredIsoValue(row.lastAt),
  }));
}

async function loadLedgerEntries(
  accountId: string,
  sessionId: string,
): Promise<SessionCostLedgerEntry[]> {
  const [llmRows, computeRows] = await Promise.all([
    db
      .select({
        id: gatewayRequestLogs.logId,
        occurredAt: gatewayRequestLogs.createdAt,
        cost: gatewayRequestLogs.finalCost,
        provider: gatewayRequestLogs.provider,
        model: gatewayRequestLogs.resolvedModel,
        requestId: gatewayRequestLogs.requestId,
        status: gatewayRequestLogs.status,
        ok: gatewayRequestLogs.ok,
        inputTokens: gatewayRequestLogs.inputTokens,
        outputTokens: gatewayRequestLogs.outputTokens,
        cachedTokens: gatewayRequestLogs.cachedTokens,
        cacheWriteTokens: gatewayRequestLogs.cacheWriteTokens,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, accountId),
          eq(gatewayRequestLogs.sessionId, sessionId),
        ),
      ),
    db
      .select({
        id: sandboxComputeSessions.id,
        startedAt: sandboxComputeSessions.startedAt,
        closedAt: sandboxComputeSessions.endedAt,
        billedThroughAt: sandboxComputeSessions.lastBilledAt,
        cost: sandboxComputeSessions.costUsd,
        provider: sandboxComputeSessions.provider,
        state: sandboxComputeSessions.state,
        cpuCores: sandboxComputeSessions.cpuCores,
        memoryGb: sandboxComputeSessions.memoryGb,
        diskGb: sandboxComputeSessions.diskGb,
        gpuCount: sandboxComputeSessions.gpuCount,
      })
      .from(sandboxComputeSessions)
      .where(
        and(
          eq(sandboxComputeSessions.accountId, accountId),
          eq(sandboxComputeSessions.sessionId, sessionId),
        ),
      ),
  ]);

  const llmEntries: SessionCostLlmLedgerEntry[] = llmRows.map((row) => ({
    kind: 'llm',
    id: row.id,
    occurred_at: requiredIsoValue(row.occurredAt),
    cost: numberValue(row.cost),
    provider: row.provider,
    model: row.model,
    request_id: row.requestId,
    status: row.status,
    ok: row.ok,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cached_tokens: row.cachedTokens,
    cache_write_tokens: row.cacheWriteTokens,
  }));

  const computeEntries: SessionCostComputeLedgerEntry[] = computeRows.map((row) => ({
    kind: 'compute',
    id: row.id,
    started_at: requiredIsoValue(row.startedAt),
    ended_at: isoValue(row.closedAt),
    billed_through_at: requiredIsoValue(row.billedThroughAt),
    cost: numberValue(row.cost),
    provider: row.provider,
    state: row.state,
    compute_seconds: computeBilledSeconds(row.startedAt, row.billedThroughAt),
    cpu_cores: row.cpuCores,
    memory_gb: row.memoryGb,
    disk_gb: row.diskGb,
    gpu_count: row.gpuCount,
  }));

  return sortLedgerEntriesNewestFirst([...llmEntries, ...computeEntries]);
}

export async function getSessionCostRecord(input: {
  accountId: string;
  projectId?: string;
  sessionId: string;
}): Promise<SessionCostDetail | null> {
  const conditions: SQL[] = [
    eq(projectSessions.accountId, input.accountId),
    eq(projectSessions.sessionId, input.sessionId),
  ];
  if (input.projectId) conditions.push(eq(projectSessions.projectId, input.projectId));

  const [session] = await db
    .select({
      sessionId: projectSessions.sessionId,
      projectId: projectSessions.projectId,
      projectName: projects.name,
      ownerId: projectSessions.createdBy,
      status: projectSessions.status,
      createdAt: projectSessions.createdAt,
      updatedAt: projectSessions.updatedAt,
    })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .where(and(...conditions))
    .limit(1);
  if (!session) return null;

  const ownerIds = session.ownerId ? [session.ownerId] : [];
  const [totals, ownerById, modelUsage, ledgerEntries] = await Promise.all([
    loadSessionTotals(input.accountId, session.sessionId),
    resolveSessionOwnerIdentities(ownerIds, input.accountId),
    loadModelUsage(input.accountId, session.sessionId),
    loadLedgerEntries(input.accountId, session.sessionId),
  ]);

  return {
    ...assembleSessionCostSummary({
      session,
      owner: session.ownerId ? ownerById.get(session.ownerId) : undefined,
      llm: totals.llm,
      compute: totals.compute,
    }),
    model_usage: modelUsage,
    ledger_entries: ledgerEntries,
  };
}

export async function listProjectGatewaySessionSpend(input: {
  accountId: string;
  projectId: string;
  days: number;
}): Promise<{ window_days: number; sessions: LegacyGatewaySessionRow[] }> {
  const [llmRows, computeRows] = await Promise.all([
    db
      .select({
        sessionId: gatewayRequestLogs.sessionId,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${gatewayRequestLogs.ok})::int`,
        cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
        tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)::float8`,
        models: sql<number>`count(distinct ${gatewayRequestLogs.requestedModel})::int`,
        lastAt: sql<Date | null>`max(${gatewayRequestLogs.createdAt})`,
      })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, input.accountId),
          eq(gatewayRequestLogs.projectId, input.projectId),
          sql`${gatewayRequestLogs.sessionId} is not null`,
          sql`${gatewayRequestLogs.createdAt} >= now() - make_interval(days => ${input.days})`,
        ),
      )
      .groupBy(gatewayRequestLogs.sessionId),
    db
      .select({
        sessionId: sandboxComputeSessions.sessionId,
        cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        seconds: sql<number>`coalesce(sum(${billedComputeSecondsExpression}), 0)::float8`,
        lastAt: sql<string | null>`max(${sandboxComputeSessions.lastBilledAt})`,
      })
      .from(sandboxComputeSessions)
      .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, sandboxComputeSessions.sessionId))
      .where(
        and(
          eq(sandboxComputeSessions.accountId, input.accountId),
          eq(sessionSandboxes.accountId, input.accountId),
          eq(sessionSandboxes.projectId, input.projectId),
          sql`${sandboxComputeSessions.sessionId} is not null`,
          sql`${sandboxComputeSessions.startedAt} >= now() - make_interval(days => ${input.days})`,
        ),
      )
      .groupBy(sandboxComputeSessions.sessionId),
  ]);

  return {
    window_days: input.days,
    sessions: mergeLegacyGatewaySessionRows(llmRows, computeRows),
  };
}
