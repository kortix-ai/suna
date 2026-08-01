import { backendApi } from '../../http/api-client';
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

export interface ListSessionCostsOptions {
  accountId?: string;
  projectId?: string;
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

export async function listSessionCosts(
  options: ListSessionCostsOptions = {},
): Promise<SessionCostsPage> {
  const query = new URLSearchParams();
  appendScopeOptions(query, options);
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
