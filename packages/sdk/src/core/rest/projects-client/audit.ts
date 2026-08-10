// Account audit log — the Enterprise reconstruction trail, backed by
// `kortix.audit_events`. The API middleware records authenticated requests.
// Domain writers add semantic session, connector, approval, and computer events.
// Per-account webhooks mirror the same stream to a SIEM. Reads are gated on
// `audit.read` + the account's `auditAccess` entitlement server-side.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  account_id?: string | null;
  project_id: string | null;
  session_id: string | null;
  opencode_session_id?: string | null;
  turn_id?: string | null;
  message_id?: string | null;
  tool_call_id?: string | null;
  execution_id?: string | null;
  session_sequence?: number | null;
  actor_user_id: string | null;
  actor_type: 'human' | 'agent' | 'service_account' | 'system' | null;
  agent_id?: string | null;
  agent_name?: string | null;
  initiator_actor_type?: string | null;
  initiator_actor_id?: string | null;
  parent_event_id?: string | null;
  delegation_depth?: number;
  source: string | null;
  authoritative_source?: string | null;
  client_reported_source?: string | null;
  outcome: 'success' | 'failure' | 'denied' | 'pending' | null;
  action: string;
  phase?: string;
  resource_type: string | null;
  resource_id: string | null;
  http_status: number | null;
  duration_ms: number | null;
  request_id: string | null;
  trace_id: string | null;
  correlation_id: string | null;
  causation_id?: string | null;
  source_ledger?: string | null;
  source_record_id?: string | null;
  source_revision?: string | null;
  input_summary?: Record<string, unknown> | null;
  output_summary?: Record<string, unknown> | null;
  input_sha256?: string | null;
  output_sha256?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  integrity_previous_hash?: string | null;
  integrity_hash?: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  metadata: unknown;
}

export interface AuditEventList {
  events: AuditEvent[];
  /** Keyset pagination cursor for the next page; null when this is the last page. */
  next_cursor: string | null;
}

export interface ListAccountAuditOptions {
  /** Prefix match on `action` (e.g. `"iam.policy."`). */
  action?: string;
  actor?: string;
  actorType?: 'human' | 'agent' | 'service_account' | 'system';
  projectId?: string;
  sessionId?: string;
  source?: string;
  /** Exact lifecycle phase, such as pending, completed, failed, or denied. */
  phase?: string;
  outcome?: 'success' | 'failure' | 'denied' | 'pending';
  resourceType?: string;
  requestId?: string;
  correlationId?: string;
  /** Only events at or after this ISO-8601 instant. */
  since?: string;
  /** Only events at or before this ISO-8601 instant. */
  until?: string;
  /** Case-insensitive action, resource, project, session, or correlation search. */
  q?: string;
  /** Keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
  /** Default 50, max 200 (server-clamped). */
  limit?: number;
}

export async function listAccountAudit(accountId: string, options?: ListAccountAuditOptions) {
  const search = new URLSearchParams();
  if (options?.action) search.set('action', options.action);
  if (options?.actor) search.set('actor', options.actor);
  if (options?.actorType) search.set('actor_type', options.actorType);
  if (options?.projectId) search.set('project_id', options.projectId);
  if (options?.sessionId) search.set('session_id', options.sessionId);
  if (options?.source) search.set('source', options.source);
  if (options?.phase) search.set('phase', options.phase);
  if (options?.outcome) search.set('outcome', options.outcome);
  if (options?.resourceType) search.set('resource_type', options.resourceType);
  if (options?.requestId) search.set('request_id', options.requestId);
  if (options?.correlationId) search.set('correlation_id', options.correlationId);
  if (options?.since) search.set('since', options.since);
  if (options?.until) search.set('until', options.until);
  if (options?.q) search.set('q', options.q);
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<AuditEventList>(`/accounts/${accountId}/audit${qs ? `?${qs}` : ''}`),
  );
}

/** Canonical project-scoped audit timeline. The API binds project scope server-side. */
export async function listProjectAudit(projectId: string, options?: ListAccountAuditOptions) {
  const search = new URLSearchParams();
  if (options?.action) search.set('action', options.action);
  if (options?.actor) search.set('actor', options.actor);
  if (options?.actorType) search.set('actor_type', options.actorType);
  if (options?.sessionId) search.set('session_id', options.sessionId);
  if (options?.source) search.set('source', options.source);
  if (options?.phase) search.set('phase', options.phase);
  if (options?.outcome) search.set('outcome', options.outcome);
  if (options?.resourceType) search.set('resource_type', options.resourceType);
  if (options?.requestId) search.set('request_id', options.requestId);
  if (options?.correlationId) search.set('correlation_id', options.correlationId);
  if (options?.since) search.set('since', options.since);
  if (options?.until) search.set('until', options.until);
  if (options?.q) search.set('q', options.q);
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<AuditEventList>(`/projects/${projectId}/audit${qs ? `?${qs}` : ''}`),
  );
}

export interface ExportAccountAuditOptions {
  format?: 'csv' | 'jsonl';
  action?: string;
  actor?: string;
  actorType?: 'human' | 'agent' | 'service_account' | 'system';
  projectId?: string;
  sessionId?: string;
  source?: string;
  phase?: string;
  outcome?: 'success' | 'failure' | 'denied' | 'pending';
  resourceType?: string;
  requestId?: string;
  correlationId?: string;
  since?: string;
  until?: string;
  q?: string;
  /** Export continuation cursor from the previous response header. */
  cursor?: string;
  /** Page size. Default and maximum are 10,000. */
  limit?: number;
}

/**
 * Stream one audit page as CSV or JSONL. Continue with the cursor returned in
 * `X-Audit-Next-Cursor` until `X-Audit-Complete` is true. The underlying REST
 * client sniffs `content-type`: a `text/csv` response resolves to a `string`;
 * `application/x-ndjson` (the JSONL response) doesn't match the client's
 * `text/*` check and resolves to a `Blob` instead — `await blob.text()` to
 * read it as a string.
 */
export async function exportAccountAudit(
  accountId: string,
  options?: ExportAccountAuditOptions,
): Promise<string | Blob> {
  const search = new URLSearchParams();
  if (options?.format) search.set('format', options.format);
  if (options?.action) search.set('action', options.action);
  if (options?.actor) search.set('actor', options.actor);
  if (options?.actorType) search.set('actor_type', options.actorType);
  if (options?.projectId) search.set('project_id', options.projectId);
  if (options?.sessionId) search.set('session_id', options.sessionId);
  if (options?.source) search.set('source', options.source);
  if (options?.phase) search.set('phase', options.phase);
  if (options?.outcome) search.set('outcome', options.outcome);
  if (options?.resourceType) search.set('resource_type', options.resourceType);
  if (options?.requestId) search.set('request_id', options.requestId);
  if (options?.correlationId) search.set('correlation_id', options.correlationId);
  if (options?.since) search.set('since', options.since);
  if (options?.until) search.set('until', options.until);
  if (options?.q) search.set('q', options.q);
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<string | Blob>(`/accounts/${accountId}/audit/export${qs ? `?${qs}` : ''}`),
  );
}

export interface AuditWebhookTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface AuditWebhook {
  webhook_id: string;
  name: string;
  url: string;
  enabled: boolean;
  action_prefix: string | null;
  last_delivered_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** Only present on the create response — the plaintext signing secret,
   *  shown exactly once. */
  secret?: string;
  /** Only present on the create response — the outcome of the one-shot test delivery. */
  test?: AuditWebhookTestResult;
}

export interface AuditWebhookListResponse {
  webhooks: AuditWebhook[];
}

export async function listAccountAuditWebhooks(accountId: string) {
  return unwrap(
    await backendApi.get<AuditWebhookListResponse>(`/accounts/${accountId}/audit/webhooks`),
  );
}

export interface CreateAuditWebhookInput {
  name: string;
  url: string;
  action_prefix?: string;
}

export async function createAccountAuditWebhook(accountId: string, input: CreateAuditWebhookInput) {
  return unwrap(
    await backendApi.post<AuditWebhook>(`/accounts/${accountId}/audit/webhooks`, input),
  );
}

export interface UpdateAuditWebhookInput {
  name?: string;
  enabled?: boolean;
  action_prefix?: string | null;
}

export async function updateAccountAuditWebhook(
  accountId: string,
  webhookId: string,
  input: UpdateAuditWebhookInput,
) {
  return unwrap(
    await backendApi.patch<AuditWebhook>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
      input,
    ),
  );
}

export async function removeAccountAuditWebhook(accountId: string, webhookId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
    ),
  );
}
