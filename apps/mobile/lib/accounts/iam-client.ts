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
