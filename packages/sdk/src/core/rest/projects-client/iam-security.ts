import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── Account MFA enforcement ──────────────────────────────────────────────

export interface MfaRequiredStatus {
  enabled: boolean;
}

export interface MfaRequiredPreview {
  total_members: number;
  members_with_mfa: number;
  /** Members without a verified MFA factor. Super-admins are still listed
   *  (so admins can nudge them) but flagged so the UI can soften the
   *  warning — super-admins remain exempt from enforcement. */
  losers: Array<{
    user_id: string;
    account_role: 'owner' | 'admin' | 'member';
    is_super_admin: boolean;
  }>;
  /** True when nobody would retain access — UI uses this to refuse the
   *  flip before round-tripping to the API. */
  will_lock_out_account: boolean;
}

export async function getMfaRequired(accountId: string) {
  return unwrap(await iamGet<MfaRequiredStatus>(`/accounts/${accountId}/iam/mfa-required`));
}

export async function previewMfaRequired(accountId: string) {
  return unwrap(
    await iamGet<MfaRequiredPreview>(`/accounts/${accountId}/iam/mfa-required/preview`),
  );
}

export async function setMfaRequired(accountId: string, enabled: boolean) {
  return unwrap(
    await backendApi.patch<{ enabled: boolean; unchanged?: boolean }>(
      `/accounts/${accountId}/iam/mfa-required`,
      { enabled },
      { showErrors: false },
    ),
  );
}

// ─── Session oversight ────────────────────────────────────────────────────

/**
 * The account policy that lets account owners and admins open EVERY session in
 * the account, members' private sessions included. Off by default. Any member
 * may read it; only an account owner may change it (`can_change`).
 */
export interface SessionOversightStatus {
  enabled: boolean;
  /** True when the caller is an account owner and may change the policy. */
  can_change: boolean;
}

export async function getSessionOversight(accountId: string) {
  return unwrap(
    await iamGet<SessionOversightStatus>(`/accounts/${accountId}/iam/session-oversight`),
  );
}

/** Owner only. An admin or member receives 403 `account_owner_required`. */
export async function setSessionOversight(accountId: string, enabled: boolean) {
  return unwrap(
    await backendApi.patch<{ enabled: boolean; unchanged?: boolean }>(
      `/accounts/${accountId}/iam/session-oversight`,
      { enabled },
      { showErrors: false },
    ),
  );
}
