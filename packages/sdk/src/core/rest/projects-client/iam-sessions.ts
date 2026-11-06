import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── Session controls ────────────────────────────────────────────────────

export interface SessionPolicy {
  /** Null = no max; positive integer = minutes. */
  max_lifetime_minutes: number | null;
  /** Null = no idle gate; positive integer = minutes. */
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

export async function getSessionPolicy(accountId: string) {
  return unwrap(await iamGet<SessionPolicy>(`/accounts/${accountId}/iam/session-policy`));
}

export async function updateSessionPolicy(accountId: string, patch: Partial<SessionPolicy>) {
  return unwrap(
    await backendApi.patch<SessionPolicy>(`/accounts/${accountId}/iam/session-policy`, patch, {
      showErrors: false,
    }),
  );
}

export async function listAccountSessions(accountId: string) {
  return unwrap(await iamGet<{ sessions: ActiveSession[] }>(`/accounts/${accountId}/iam/sessions`))
    .sessions;
}

export async function revokeAccountSession(accountId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ revoked: boolean }>(
      `/accounts/${accountId}/iam/sessions/${sessionId}/revoke`,
      {},
      { showErrors: false },
    ),
  );
}

// ─── PAT lifecycle policy ─────────────────────────────────────────────────

export interface PatPolicy {
  /** Null = no cap; positive integer = days from now. */
  max_lifetime_days: number | null;
  /** When true, minting without expires_at is refused. */
  require_expiry: boolean;
  /** Null = no idle revoke; positive integer = days. */
  idle_revoke_days: number | null;
}

export async function getPatPolicy(accountId: string) {
  return unwrap(await iamGet<PatPolicy>(`/accounts/${accountId}/iam/pat-policy`));
}

export async function updatePatPolicy(accountId: string, patch: Partial<PatPolicy>) {
  return unwrap(
    await backendApi.patch<PatPolicy>(`/accounts/${accountId}/iam/pat-policy`, patch, {
      showErrors: false,
    }),
  );
}
