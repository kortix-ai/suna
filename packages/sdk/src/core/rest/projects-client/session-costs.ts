import { backendApi } from '../../http/api-client';
import { platformConfig } from '../../http/config';
import type { ProjectSessionStatus } from './sessions';
import { unwrap } from './shared';

export type SessionCostOwnerType = 'user' | 'service_account' | 'unknown';

export interface SessionCostSummary {
  session_id: string;
  project_id: string;
  project_name: string;
  owner_id: string | null;
  owner_type: SessionCostOwnerType | null;
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

export type SessionCostLedgerEntry =
  | SessionCostLlmLedgerEntry
  | SessionCostComputeLedgerEntry;

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

export interface SessionCostsPage {
  sessions: SessionCostSummary[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  reconciliation: SessionCostReconciliation;
}

/**
 * Shared half-open [from, to) date window, mirroring `CostWindow` /
 * `parseCostWindow` on the API (`apps/api/src/shared/cost-window.ts`). Both
 * bounds are ISO-8601 UTC instants. Omitting both defaults server-side to the
 * trailing 30 days — the client never guesses that default itself.
 */
export interface CostWindowOptions {
  from?: string;
  to?: string;
}

/**
 * The three sorts `GET /usage/session-costs` accepts (`SESSION_COST_SORTS` in
 * `apps/api/src/router/routes/usage.ts`). A session page has no project name
 * to sort on, so `name_asc` is deliberately excluded here.
 */
export type SessionCostSort = 'total_desc' | 'total_asc' | 'recent';

/**
 * The four sorts `GET /usage/cost-by-project` accepts (`PROJECT_COST_SORTS`
 * in the same route file) — every `SessionCostSort` plus `name_asc`, since a
 * project rollup row has a name to sort on.
 */
export type ProjectCostSort = SessionCostSort | 'name_asc';

export interface ListSessionCostsOptions extends CostWindowOptions {
  accountId?: string;
  projectId?: string;
  /** Filter to sessions owned by this user/service-account id. */
  ownerId?: string;
  sort?: SessionCostSort;
  limit?: number;
  offset?: number;
}

export interface GetSessionCostRecordOptions {
  accountId?: string;
  projectId?: string;
}

function appendScopeOptions(
  query: URLSearchParams,
  options: GetSessionCostRecordOptions,
): void {
  if (options.accountId) query.set('account_id', options.accountId);
  if (options.projectId) query.set('project_id', options.projectId);
}

function appendWindow(query: URLSearchParams, options: CostWindowOptions): void {
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
}

export async function listSessionCosts(
  options: ListSessionCostsOptions = {},
): Promise<SessionCostsPage> {
  const query = new URLSearchParams();
  appendScopeOptions(query, options);
  if (options.ownerId) query.set('owner_id', options.ownerId);
  appendWindow(query, options);
  if (options.sort) query.set('sort', options.sort);
  if (options.limit != null) query.set('limit', String(options.limit));
  if (options.offset != null) query.set('offset', String(options.offset));
  const suffix = query.size > 0 ? `?${query}` : '';
  return unwrap(await backendApi.get<SessionCostsPage>(`/usage/session-costs${suffix}`));
}

export async function getSessionCostRecord(
  sessionId: string,
  options: GetSessionCostRecordOptions = {},
): Promise<SessionCostDetail> {
  const query = new URLSearchParams();
  appendScopeOptions(query, options);
  const suffix = query.size > 0 ? `?${query}` : '';
  return unwrap(
    await backendApi.get<SessionCostDetail>(
      `/usage/session-costs/${encodeURIComponent(sessionId)}${suffix}`,
    ),
  );
}

// ── Project rollup — GET /usage/cost-by-project ────────────────────────────
// Mirrors `ProjectCostRow` / `ProjectCostPage` in
// `apps/api/src/shared/cost-rollups.ts` field for field. There is no
// `unassigned` field on this response — compute/LLM spend the API cannot
// attribute to any project is folded into the account-wide totals returned
// by `getCostSummary` below, never surfaced as a synthetic row here.

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

export interface ListCostByProjectOptions extends CostWindowOptions {
  accountId?: string;
  sort?: ProjectCostSort;
  limit?: number;
  offset?: number;
}

export async function listCostByProject(
  options: ListCostByProjectOptions = {},
): Promise<ProjectCostPage> {
  const query = new URLSearchParams();
  if (options.accountId) query.set('account_id', options.accountId);
  appendWindow(query, options);
  if (options.sort) query.set('sort', options.sort);
  if (options.limit != null) query.set('limit', String(options.limit));
  if (options.offset != null) query.set('offset', String(options.offset));
  const suffix = query.size > 0 ? `?${query}` : '';
  return unwrap(await backendApi.get<ProjectCostPage>(`/usage/cost-by-project${suffix}`));
}

// ── Spend summary — GET /usage/cost-summary ─────────────────────────────────
// Mirrors `CostSummaryTotals` / `CostSeriesPoint` / `CostModelRow` /
// `CostSummary` in `apps/api/src/shared/cost-rollups.ts` field for field.

export interface CostSummaryTotals {
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  request_count: number;
  compute_seconds: number;
  session_count: number;
  project_count: number;
}

export interface CostSeriesPoint {
  day: string;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
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

export interface GetCostSummaryOptions extends CostWindowOptions {
  accountId?: string;
  projectId?: string;
  sessionId?: string;
}

export async function getCostSummary(
  options: GetCostSummaryOptions = {},
): Promise<CostSummary> {
  const query = new URLSearchParams();
  appendScopeOptions(query, options);
  if (options.sessionId) query.set('session_id', options.sessionId);
  appendWindow(query, options);
  const suffix = query.size > 0 ? `?${query}` : '';
  return unwrap(await backendApi.get<CostSummary>(`/usage/cost-summary${suffix}`));
}

// ── CSV export URLs ──────────────────────────────────────────────────────
// Pure URL builders — neither function calls `fetch`. `GET /usage/cost-by-project`
// and `GET /usage/session-costs` both require a Bearer token (combinedAuth has
// no query-token fallback for these routes — see
// `apps/api/src/middleware/auth.ts`), so the caller is responsible for
// attaching auth when it requests this URL (e.g. an authenticated `fetch` that
// turns the response into a downloadable Blob), the same way
// `fetchProjectArchive` in `./files.ts` does for the project-archive download.

export interface CostExportOptions extends CostWindowOptions {
  accountId?: string;
  /** `kind: 'sessions'` only — ignored for `kind: 'projects'`, which has no
   *  project/owner query param on its route. */
  projectId?: string;
  /** `kind: 'sessions'` only — ignored for `kind: 'projects'`. */
  ownerId?: string;
  /** `ProjectCostSort` is a superset of `SessionCostSort`, so this one field
   *  type covers both `kind`s without a discriminated overload. */
  sort?: ProjectCostSort;
}

export function costExportUrl(
  kind: 'projects' | 'sessions',
  options: CostExportOptions = {},
): string {
  const query = new URLSearchParams();
  if (options.accountId) query.set('account_id', options.accountId);
  if (kind === 'sessions') {
    if (options.projectId) query.set('project_id', options.projectId);
    if (options.ownerId) query.set('owner_id', options.ownerId);
  }
  appendWindow(query, options);
  if (options.sort) query.set('sort', options.sort);
  query.set('format', 'csv');
  const path = kind === 'projects' ? '/usage/cost-by-project' : '/usage/session-costs';
  return `${platformConfig().backendUrl || ''}${path}?${query}`;
}
