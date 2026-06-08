/**
 * IAM data layer for the Account → Settings security / token / observability
 * cards (web parity: lib/iam-client.ts subset). MFA enforcement, session policy
 * + active sessions, PAT policy, service accounts, and audit webhooks.
 */

import { apiFetch } from '@/lib/projects/projects-client';

const iam = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/iam`;

// ── MFA enforcement ───────────────────────────────────────────────────────────

export interface MfaRequiredStatus {
  enabled: boolean;
}
export interface MfaRequiredPreview {
  total_members: number;
  members_with_mfa: number;
  losers: Array<{ user_id: string; account_role: 'owner' | 'admin' | 'member'; is_super_admin: boolean }>;
  will_lock_out_account: boolean;
}

export function getMfaRequired(accountId: string) {
  return apiFetch<MfaRequiredStatus>(`${iam(accountId)}/mfa-required`);
}
export function previewMfaRequired(accountId: string) {
  return apiFetch<MfaRequiredPreview>(`${iam(accountId)}/mfa-required/preview`);
}
export function setMfaRequired(accountId: string, enabled: boolean) {
  return apiFetch<{ enabled: boolean; unchanged?: boolean }>(`${iam(accountId)}/mfa-required`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

// ── Session policy + active sessions ──────────────────────────────────────────

export interface SessionPolicy {
  max_lifetime_minutes: number | null;
  idle_timeout_minutes: number | null;
}
export interface ActiveSession {
  user_id: string;
  session_id: string;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

export function getSessionPolicy(accountId: string) {
  return apiFetch<SessionPolicy>(`${iam(accountId)}/session-policy`);
}
export function updateSessionPolicy(accountId: string, patch: Partial<SessionPolicy>) {
  return apiFetch<SessionPolicy>(`${iam(accountId)}/session-policy`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function listAccountSessions(accountId: string) {
  const res = await apiFetch<{ sessions: ActiveSession[] }>(`${iam(accountId)}/sessions`);
  return res.sessions;
}
export function revokeAccountSession(accountId: string, sessionId: string) {
  return apiFetch<{ revoked: boolean }>(`${iam(accountId)}/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── PAT (CLI token) policy ────────────────────────────────────────────────────

export interface PatPolicy {
  max_lifetime_days: number | null;
  require_expiry: boolean;
  idle_revoke_days: number | null;
}

export function getPatPolicy(accountId: string) {
  return apiFetch<PatPolicy>(`${iam(accountId)}/pat-policy`);
}
export function updatePatPolicy(accountId: string, patch: Partial<PatPolicy>) {
  return apiFetch<PatPolicy>(`${iam(accountId)}/pat-policy`, { method: 'PATCH', body: JSON.stringify(patch) });
}

// ── Service accounts ──────────────────────────────────────────────────────────

export interface ServiceAccount {
  service_account_id: string;
  name: string;
  description: string | null;
  public_prefix: string;
  status: 'active' | 'disabled';
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  disabled_at: string | null;
}
export interface CreatedServiceAccount extends ServiceAccount {
  /** Plaintext bearer — shown ONCE at create. */
  secret: string;
}

export async function listServiceAccounts(accountId: string) {
  const res = await apiFetch<{ service_accounts: ServiceAccount[] }>(`${iam(accountId)}/service-accounts`);
  return res.service_accounts;
}
export function createServiceAccount(accountId: string, input: { name: string; description?: string }) {
  return apiFetch<CreatedServiceAccount>(`${iam(accountId)}/service-accounts`, { method: 'POST', body: JSON.stringify(input) });
}
export function disableServiceAccount(accountId: string, saId: string) {
  return apiFetch<{ disabled: boolean }>(`${iam(accountId)}/service-accounts/${encodeURIComponent(saId)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
export function deleteServiceAccount(accountId: string, saId: string) {
  return apiFetch<{ deleted: boolean }>(`${iam(accountId)}/service-accounts/${encodeURIComponent(saId)}`, { method: 'DELETE' });
}

// ── Audit webhooks ────────────────────────────────────────────────────────────

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
}
export interface CreatedAuditWebhook extends AuditWebhook {
  /** Plaintext HMAC signing secret — returned ONCE on create. */
  secret: string;
}

// ── Member IAM detail ─────────────────────────────────────────────────────────

export interface MemberGroupSummary {
  group_id: string;
  name: string;
  added_at: string;
}
export interface MemberProjectAccess {
  project_id: string;
  project_name: string;
  role: 'manager' | 'editor' | 'viewer';
  sources: Array<'implicit' | 'direct' | 'group'>;
}

export async function listMemberGroups(accountId: string, userId: string) {
  const res = await apiFetch<{ groups: MemberGroupSummary[] }>(`${iam(accountId)}/members/${encodeURIComponent(userId)}/groups`);
  return res.groups;
}
export async function listMemberProjectAccess(accountId: string, userId: string) {
  const res = await apiFetch<{ projects: MemberProjectAccess[] }>(`${iam(accountId)}/members/${encodeURIComponent(userId)}/project-access`);
  return res.projects;
}
export function setMemberSuperAdmin(accountId: string, userId: string, isSuperAdmin: boolean) {
  return apiFetch<{ user_id: string; is_super_admin: boolean }>(`${iam(accountId)}/members/${encodeURIComponent(userId)}/super-admin`, {
    method: 'PATCH',
    body: JSON.stringify({ isSuperAdmin }),
  });
}

const auditHooks = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/audit/webhooks`;

export async function listAuditWebhooks(accountId: string) {
  const res = await apiFetch<{ webhooks: AuditWebhook[] }>(auditHooks(accountId));
  return res.webhooks;
}
export function createAuditWebhook(accountId: string, input: { name: string; url: string; action_prefix?: string }) {
  return apiFetch<CreatedAuditWebhook>(auditHooks(accountId), { method: 'POST', body: JSON.stringify(input) });
}
export function updateAuditWebhook(accountId: string, webhookId: string, patch: { name?: string; enabled?: boolean; action_prefix?: string | null }) {
  return apiFetch<AuditWebhook>(`${auditHooks(accountId)}/${encodeURIComponent(webhookId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteAuditWebhook(accountId: string, webhookId: string) {
  return apiFetch<{ deleted: boolean }>(`${auditHooks(accountId)}/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
}
