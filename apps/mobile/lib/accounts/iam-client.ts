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
