import { backendApi } from '../../http/api-client';
import { getSupabaseAccessTokenWithRetry } from '../../http/auth';
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
  /**
   * The `llm_cost` slice Kortix debited from your wallet — managed inference,
   * or the platform fee on a BYOK route.
   */
  llm_kortix_cost: number;
  /**
   * The `llm_cost` slice you paid your own provider directly, on your own key.
   * Always 0 for Kortix-managed traffic, where the upstream price is Kortix's
   * wholesale cost rather than yours.
   */
  llm_provider_cost: number;
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

/** `?<query>` when non-empty, else `''` — shared by every list/get below so
 *  the empty-query case (no trailing `?`) is expressed exactly once. */
function suffix(query: URLSearchParams): string {
  return query.size > 0 ? `?${query}` : '';
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
  return unwrap(await backendApi.get<SessionCostsPage>(`/usage/session-costs${suffix(query)}`));
}

export async function getSessionCostRecord(
  sessionId: string,
  options: GetSessionCostRecordOptions = {},
): Promise<SessionCostDetail> {
  const query = new URLSearchParams();
  appendScopeOptions(query, options);
  return unwrap(
    await backendApi.get<SessionCostDetail>(
      `/usage/session-costs/${encodeURIComponent(sessionId)}${suffix(query)}`,
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
  /**
   * The `llm_cost` slice Kortix debited from your wallet — managed inference,
   * or the platform fee on a BYOK route.
   */
  llm_kortix_cost: number;
  /**
   * The `llm_cost` slice you paid your own provider directly, on your own key.
   * Always 0 for Kortix-managed traffic, where the upstream price is Kortix's
   * wholesale cost rather than yours.
   */
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
  return unwrap(await backendApi.get<ProjectCostPage>(`/usage/cost-by-project${suffix(query)}`));
}

// ── Spend summary — GET /usage/cost-summary ─────────────────────────────────
// Mirrors `CostSummaryTotals` / `CostSeriesPoint` / `CostModelRow` /
// `CostSummary` in `apps/api/src/shared/cost-rollups.ts` field for field.

export interface CostSummaryTotals {
  llm_cost: number;
  /**
   * The `llm_cost` slice Kortix debited from your wallet — managed inference,
   * or the platform fee on a BYOK route.
   */
  llm_kortix_cost: number;
  /**
   * The `llm_cost` slice you paid your own provider directly, on your own key.
   * Always 0 for Kortix-managed traffic, where the upstream price is Kortix's
   * wholesale cost rather than yours.
   */
  llm_provider_cost: number;
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
  return unwrap(await backendApi.get<CostSummary>(`/usage/cost-summary${suffix(query)}`));
}

// ── CSV export ────────────────────────────────────────────────────────────
// `GET /usage/cost-by-project` and `GET /usage/session-costs` (format=csv)
// both require a Bearer token — combinedAuth has no query-token fallback for
// these routes (see `apps/api/src/middleware/auth.ts`: the ?token= fallback
// is reserved for the legacy /provision-stream EventSource path only, with an
// explicit warning against extending it — it "leaks bearer material into
// URLs, logs, history, and Referer headers"). So a bare `<a href>` or
// `window.open()` against a `costExportUrl()` result 401s.
//
// `fetchCostExportCsv` below owns the whole authenticated flow — attach the
// token, fetch, return a Blob — the same pattern `fetchProjectArchive` in
// `./files.ts` already uses for the project-archive download (it calls
// `getSupabaseAccessTokenWithRetry()` itself, attaches the header itself,
// and returns a `Blob`). `costExportUrl` stays exported alongside it as the
// pure URL builder, for a caller that wants the URL without immediately
// fetching it (e.g. to hand to a different authenticated transport, or to
// display/copy) — removing it now would break the export this task already
// published.

/** Options accepted by `costExportUrl('projects', …)` / `fetchCostExportCsv('projects', …)`.
 *  No `projectId`/`ownerId` — `/cost-by-project` has no such query param. */
export interface ProjectCostExportOptions extends CostWindowOptions {
  accountId?: string;
  sort?: ProjectCostSort;
}

/** Options accepted by `costExportUrl('sessions', …)` / `fetchCostExportCsv('sessions', …)`.
 *  `sort` is `SessionCostSort`, not `ProjectCostSort` — `name_asc` is only
 *  valid on the project rollup (SESSION_COST_SORTS excludes it on the API,
 *  so passing it here would compile before this fix and 400 at request time). */
export interface SessionCostExportOptions extends CostWindowOptions {
  accountId?: string;
  projectId?: string;
  ownerId?: string;
  sort?: SessionCostSort;
}

/** Convenience union of the two kind-specific option shapes above. Kept as
 *  its own exported name (rather than removed) because `costExportUrl` was
 *  already published with a single flat `CostExportOptions` parameter type;
 *  the discriminated overloads below are what actually enforces the
 *  per-`kind` field set now — this union just lets a caller hold "whichever
 *  export options" without picking a kind up front. */
export type CostExportOptions = ProjectCostExportOptions | SessionCostExportOptions;

/** Pure URL builder — never calls `fetch`. See the section comment above for
 *  why a bare `<a href>`/`window.open()` against this URL 401s, and why
 *  `fetchCostExportCsv` (not this) is the function that actually downloads. */
export function costExportUrl(kind: 'projects', options?: ProjectCostExportOptions): string;
export function costExportUrl(kind: 'sessions', options?: SessionCostExportOptions): string;
export function costExportUrl(
  kind: 'projects' | 'sessions',
  options: ProjectCostExportOptions | SessionCostExportOptions = {},
): string {
  const query = new URLSearchParams();
  if (options.accountId) query.set('account_id', options.accountId);
  if (kind === 'sessions') {
    const sessionOptions = options as SessionCostExportOptions;
    if (sessionOptions.projectId) query.set('project_id', sessionOptions.projectId);
    if (sessionOptions.ownerId) query.set('owner_id', sessionOptions.ownerId);
  }
  appendWindow(query, options);
  if (options.sort) query.set('sort', options.sort);
  query.set('format', 'csv');
  const path = kind === 'projects' ? '/usage/cost-by-project' : '/usage/session-costs';
  return `${platformConfig().backendUrl || ''}${path}?${query}`;
}

export interface CostExportResult {
  blob: Blob;
  /** Parsed `x-kortix-row-cap` response header — `CSV_ROW_CAP` in
   *  `apps/api/src/shared/cost-csv.ts` — or `null` when the header is absent
   *  or unparseable. Both CSV export routes always set it, but the header is
   *  not part of either route's JSON response schema, so a caller needing to
   *  warn "your finance export was capped at N rows" can only get this
   *  number from here, not from the CSV body itself. */
  rowCap: number | null;
}

/**
 * Fetch a CSV export as a `Blob`, owning the whole authenticated flow —
 * mirrors `fetchProjectArchive` in `./files.ts`: resolves the current token
 * via `getSupabaseAccessTokenWithRetry()`, attaches
 * `Authorization: Bearer <token>` itself, and throws with the response body
 * on a non-OK response.
 */
export function fetchCostExportCsv(
  kind: 'projects',
  options?: ProjectCostExportOptions,
): Promise<CostExportResult>;
export function fetchCostExportCsv(
  kind: 'sessions',
  options?: SessionCostExportOptions,
): Promise<CostExportResult>;
export async function fetchCostExportCsv(
  kind: 'projects' | 'sessions',
  options: ProjectCostExportOptions | SessionCostExportOptions = {},
): Promise<CostExportResult> {
  // Delegates to costExportUrl for the URL itself — kind is narrowed to a
  // literal in each branch, which is what lets the two-overload function be
  // called at all (an overloaded function can't be called with a
  // non-narrowed 'projects' | 'sessions' variable directly). This also
  // guarantees the fetched URL can never drift from what costExportUrl
  // builds and this file's costExportUrl tests already cover.
  const url =
    kind === 'projects'
      ? costExportUrl('projects', options as ProjectCostExportOptions)
      : costExportUrl('sessions', options as SessionCostExportOptions);

  const token = await getSupabaseAccessTokenWithRetry();
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to export CSV (HTTP ${res.status})`);
  }

  const rowCapHeader = res.headers.get('x-kortix-row-cap');
  const parsedRowCap = rowCapHeader != null ? Number(rowCapHeader) : NaN;
  const blob = await res.blob();
  return { blob, rowCap: Number.isFinite(parsedRowCap) ? parsedRowCap : null };
}
