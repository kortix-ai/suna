import { backendApi } from '@/lib/api-client';

export interface GatewayLogRow {
  log_id: string;
  request_id: string;
  created_at: string;
  requested_model: string;
  resolved_model: string;
  provider: string;
  status: number;
  ok: boolean;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  upstream_cost: number;
  final_cost: number;
  streaming: boolean;
  billing_mode: string | null;
  actor_user_id: string | null;
  key_id: string | null;
}

export interface GatewayLogDetail extends GatewayLogRow {
  candidates_tried: string[];
  request: unknown;
  response: unknown;
  metadata: Record<string, unknown>;
}

export interface GatewayLogsResponse {
  logs: GatewayLogRow[];
  next_offset: number | null;
}

export interface GatewayOverview {
  window_days: number;
  requests: number;
  errors: number;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

export interface GatewaySeriesPoint {
  day: string;
  requests: number;
  errors: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface GatewayErrorStat {
  code: string;
  count: number;
}

export interface GatewayErrorsResponse {
  window_days: number;
  errors: GatewayErrorStat[];
}

export interface GatewaySeries {
  window_days: number;
  series: GatewaySeriesPoint[];
}

export interface GatewayModelStat {
  model: string;
  provider: string;
  requests: number;
  errors: number;
  cost: number;
  tokens: number;
}

export interface GatewayBreakdown {
  window_days: number;
  models: GatewayModelStat[];
}

export interface GatewayBudgetRow {
  budget_id: string;
  scope: 'project' | 'member';
  subject_user_id: string | null;
  limit_usd: number;
  period: 'day' | 'week' | 'month';
  action: 'block' | 'warn';
}

export interface GatewayMemberSpend {
  user_id: string | null;
  email: string | null;
  requests: number;
  cost: number;
  tokens: number;
}

export interface GatewayBudgetsResponse {
  project_spend: { requests: number; cost: number };
  budgets: GatewayBudgetRow[];
  members: GatewayMemberSpend[];
}

export interface SetGatewayBudgetInput {
  scope: 'project' | 'member';
  subject_user_id?: string | null;
  limit_usd: number;
  period?: 'day' | 'week' | 'month';
  action?: 'block' | 'warn';
}

export interface GatewayKeyRow {
  key_id: string;
  name: string;
  key_prefix: string;
  status: 'active' | 'revoked' | 'expired';
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedGatewayKey {
  key_id: string;
  name: string;
  key_prefix: string;
  secret_key: string;
}

export interface GatewayPlaygroundResult {
  model: string;
  ok: boolean;
  latency_ms?: number;
  output?: string;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Gateway request failed');
  }
  return response.data;
}

export async function listGatewayLogs(
  projectId: string,
  opts?: { limit?: number; offset?: number; ok?: boolean },
): Promise<GatewayLogsResponse> {
  const q = new URLSearchParams();
  if (opts?.limit) q.set('limit', String(opts.limit));
  if (opts?.offset) q.set('offset', String(opts.offset));
  if (opts?.ok !== undefined) q.set('ok', String(opts.ok));
  const qs = q.toString();
  return unwrap(
    await backendApi.get<GatewayLogsResponse>(`/projects/${projectId}/gateway/logs${qs ? `?${qs}` : ''}`),
  );
}

export async function getGatewayLog(projectId: string, logId: string): Promise<GatewayLogDetail> {
  return unwrap(await backendApi.get<GatewayLogDetail>(`/projects/${projectId}/gateway/logs/${logId}`));
}

export async function getGatewayOverview(projectId: string, days?: number): Promise<GatewayOverview> {
  return unwrap(
    await backendApi.get<GatewayOverview>(
      `/projects/${projectId}/gateway/overview${days ? `?days=${days}` : ''}`,
    ),
  );
}

export async function getGatewaySeries(projectId: string, days?: number): Promise<GatewaySeries> {
  return unwrap(
    await backendApi.get<GatewaySeries>(
      `/projects/${projectId}/gateway/series${days ? `?days=${days}` : ''}`,
    ),
  );
}

export async function getGatewayBreakdown(projectId: string, days?: number): Promise<GatewayBreakdown> {
  return unwrap(
    await backendApi.get<GatewayBreakdown>(
      `/projects/${projectId}/gateway/breakdown${days ? `?days=${days}` : ''}`,
    ),
  );
}

export async function getGatewayErrors(projectId: string, days?: number): Promise<GatewayErrorsResponse> {
  return unwrap(
    await backendApi.get<GatewayErrorsResponse>(
      `/projects/${projectId}/gateway/errors${days ? `?days=${days}` : ''}`,
    ),
  );
}

export async function getGatewayBudgets(projectId: string): Promise<GatewayBudgetsResponse> {
  return unwrap(await backendApi.get<GatewayBudgetsResponse>(`/projects/${projectId}/gateway/budgets`));
}

export async function setGatewayBudget(
  projectId: string,
  input: SetGatewayBudgetInput,
): Promise<{ ok: boolean }> {
  return unwrap(await backendApi.put<{ ok: boolean }>(`/projects/${projectId}/gateway/budgets`, input));
}

export async function deleteGatewayBudget(
  projectId: string,
  budgetId: string,
): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/gateway/budgets/${budgetId}`),
  );
}

export async function getGatewayKeys(projectId: string): Promise<{ keys: GatewayKeyRow[] }> {
  return unwrap(await backendApi.get<{ keys: GatewayKeyRow[] }>(`/projects/${projectId}/gateway/keys`));
}

export async function createGatewayKey(
  projectId: string,
  name: string,
): Promise<CreatedGatewayKey> {
  return unwrap(
    await backendApi.post<CreatedGatewayKey>(`/projects/${projectId}/gateway/keys`, { name }),
  );
}

export async function revokeGatewayKey(
  projectId: string,
  keyId: string,
): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/gateway/keys/${keyId}`),
  );
}

export async function runGatewayPlayground(
  projectId: string,
  prompt: string,
  models: string[],
): Promise<{ results: GatewayPlaygroundResult[] }> {
  return unwrap(
    await backendApi.post<{ results: GatewayPlaygroundResult[] }>(
      `/projects/${projectId}/gateway/playground`,
      { prompt, models },
    ),
  );
}
