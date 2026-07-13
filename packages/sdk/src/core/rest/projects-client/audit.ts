// Account audit log — the Enterprise "what changed" trail, backed by
// `kortix.audit_events` (every mutation the global middleware + IAM helpers
// record) plus per-account outbound webhooks that mirror it to a SIEM. Reads
// are gated on `audit.read` + the account's `auditAccess` entitlement server-side.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
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
  /** Only events at or after this ISO-8601 instant. */
  since?: string;
  /** Keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
  /** Default 50, max 200 (server-clamped). */
  limit?: number;
}

export async function listAccountAudit(accountId: string, options?: ListAccountAuditOptions) {
  const search = new URLSearchParams();
  if (options?.action) search.set('action', options.action);
  if (options?.since) search.set('since', options.since);
  if (options?.cursor) search.set('cursor', options.cursor);
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<AuditEventList>(`/accounts/${accountId}/audit${qs ? `?${qs}` : ''}`),
  );
}

export interface ExportAccountAuditOptions {
  format?: 'csv' | 'jsonl';
  action?: string;
  since?: string;
}

/**
 * Stream an audit slice as CSV or JSONL (hard-capped at 10,000 rows per
 * request — page via repeated `since=` calls for more). The underlying REST
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
  if (options?.since) search.set('since', options.since);
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

export async function createAccountAuditWebhook(
  accountId: string,
  input: CreateAuditWebhookInput,
) {
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
