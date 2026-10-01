import { appendQuery } from './iam-query';
import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { AuditEvent } from './audit';

// ─── Audit webhooks ────────────────────────────────────────────────────────

export interface IamAuditWebhook {
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
}

export interface CreatedAuditWebhook extends IamAuditWebhook {
  /** Plaintext HMAC signing secret — returned ONCE on create. Use it to
   *  verify the X-Kortix-Signature header in your receiver. */
  secret: string;
  /** Outcome of the one-shot test delivery fired at creation — lets the UI warn
   *  on an unreachable URL immediately instead of after silent audit-event loss. */
  test?: { ok: boolean; status?: number; error?: string };
}

export async function listAuditWebhooks(accountId: string) {
  return unwrap(
    await iamGet<{ webhooks: IamAuditWebhook[] }>(`/accounts/${accountId}/audit/webhooks`),
  ).webhooks;
}

export async function createAuditWebhook(
  accountId: string,
  input: { name: string; url: string; action_prefix?: string },
) {
  return unwrap(
    await backendApi.post<CreatedAuditWebhook>(`/accounts/${accountId}/audit/webhooks`, input, {
      showErrors: false,
    }),
  );
}

export async function updateAuditWebhook(
  accountId: string,
  webhookId: string,
  patch: { name?: string; enabled?: boolean; action_prefix?: string | null },
) {
  return unwrap(
    await backendApi.patch<IamAuditWebhook>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
      patch,
    ),
  );
}

export async function deleteAuditWebhook(accountId: string, webhookId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
    ),
  );
}

// ─── Audit log ─────────────────────────────────────────────────────────────

export interface IamAuditEvent extends AuditEvent {
  event_id: string;
  occurred_at: string;
  project_id: string | null;
  session_id: string | null;
  actor_user_id: string | null;
  actor_type: 'human' | 'agent' | 'service_account' | 'system' | 'anonymous' | null;
  source: string | null;
  outcome: 'success' | 'failure' | 'denied' | 'pending' | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  http_status: number | null;
  duration_ms: number | null;
  request_id: string | null;
  trace_id: string | null;
  correlation_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export interface ListAuditFilter {
  /** Prefix or exact match on action string ("iam.policy" matches every
   *  iam.policy.* event; "iam.policy.create" matches exact). */
  action?: string;
  /** Only events performed by this user_id. */
  actor?: string;
  project_id?: string;
  session_id?: string;
  actor_type?: 'human' | 'agent' | 'service_account' | 'system' | 'anonymous';
  /** Trusted execution source (`authoritative_source`). */
  source?: string;
  /** Credential class the API authenticated, e.g. `oauth_app`. */
  credential_kind?: string;
  phase?: string;
  outcome?: 'success' | 'failure' | 'denied' | 'pending';
  request_id?: string;
  correlation_id?: string;
  /** Prefix match on resource_type (e.g. "project_session"). */
  resource_type?: string;
  /** ISO datetime — events at or after. */
  since?: string;
  /** ISO datetime — events at or before. */
  until?: string;
  /** Case-insensitive substring over action / resource_type / resource_id. */
  q?: string;
  /** Cursor from a previous response's next_cursor. */
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

export async function listAuditEvents(accountId: string, filter: ListAuditFilter = {}) {
  const query = appendQuery({ action: filter.action, actor: filter.actor, project_id: filter.project_id, session_id: filter.session_id, actor_type: filter.actor_type, source: filter.source, credential_kind: filter.credential_kind, phase: filter.phase, outcome: filter.outcome, request_id: filter.request_id, correlation_id: filter.correlation_id, resource_type: filter.resource_type, since: filter.since, until: filter.until, q: filter.q, cursor: filter.cursor, limit: filter.limit });
  return unwrap(
    await iamGet<{ events: IamAuditEvent[]; next_cursor: string | null }>(
      `/accounts/${accountId}/audit${query}`,
    ),
  );
}
