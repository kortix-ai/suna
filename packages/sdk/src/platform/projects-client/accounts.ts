// Accounts — account CRUD, members, and account-level invitations.

import { backendApi } from '../api-client';
import type { ApiError } from '../api/errors';
import { serverTokenGet, unwrap, type AccountRole, type ServerTokenOptions } from './shared';

export interface KortixAccount {
  account_id: string;
  name: string;
  slug?: string;
  account_role?: string;
  is_primary_owner?: boolean;
}

export interface AccountDetail {
  account_id: string;
  name: string;
  /** When true the account is on the simplified IAM V2 model (3 account
   *  roles + 3 project roles, no DB-driven policies). Drives whether the
   *  frontend shows the V1 Policies/Roles tabs or the V2 simple UI. */
  iam_v2_enabled?: boolean;
  member_count: number;
  project_count: number;
  role: AccountRole;
  created_at: string;
  updated_at: string;
}

export interface AccountMemberGroup {
  group_id: string;
  name: string;
}

export interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  is_super_admin?: boolean;
  explicit_project_count?: number;
  groups?: AccountMemberGroup[];
  /** Number of active CLI Personal Access Tokens this user owns in
   *  this account. Lets the UI flag members with API automation. */
  active_pat_count?: number;
  /** True when the user has at least one verified MFA factor in
   *  Supabase Auth. */
  has_verified_mfa?: boolean;
  joined_at: string;
}

export type InviteMemberResult =
  | {
      status: 'added';
      user_id: string;
      email: string;
      account_role: AccountRole;
    }
  | {
      status: 'pending';
      invite_id: string;
      email: string;
      account_role: AccountRole;
      expires_at: string;
      invite_url: string;
      email_sent: boolean;
      email_skip_reason: string | null;
    };

export interface AccountInvitation {
  invite_id: string;
  email: string;
  initial_role: AccountRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
  invite_url: string;
}

export interface ResendInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

export interface AccountInviteDescribeFull {
  invite_id: string;
  account_id: string;
  account_name: string | null;
  email: string;
  initial_role: AccountRole;
  inviter_email: string | null;
  created_at: string;
  expires_at: string;
  expired: boolean;
  accepted_at: string | null;
  email_matches_caller: true;
}

export interface AccountInviteDescribeRedacted {
  invite_id: string;
  expired: boolean;
  accepted_at: string | null;
  email_matches_caller: false;
  account_id?: null;
  account_name?: null;
  email?: null;
  initial_role?: null;
  inviter_email?: null;
  created_at?: null;
  expires_at?: null;
}

export type AccountInviteDescribe =
  | AccountInviteDescribeFull
  | AccountInviteDescribeRedacted;

export async function listAccounts() {
  return unwrap(await backendApi.get<KortixAccount[]>('/accounts'));
}

export async function createAccount(input: { name: string }) {
  return unwrap(await backendApi.post<KortixAccount>('/accounts', input));
}

export async function getAccount(accountId: string) {
  return unwrap(await backendApi.get<AccountDetail>(`/accounts/${accountId}`));
}

export async function updateAccountName(accountId: string, name: string) {
  return unwrap(
    await backendApi.patch<AccountDetail>(`/accounts/${accountId}`, { name }),
  );
}

export async function listAccountMembers(accountId: string) {
  return unwrap(
    await backendApi.get<AccountMember[]>(`/accounts/${accountId}/members`),
  );
}

export async function inviteAccountMember(
  accountId: string,
  input: { email: string; role?: AccountRole },
) {
  return unwrap(
    await backendApi.post<InviteMemberResult>(
      `/accounts/${accountId}/members`,
      input,
      {
        // 409 (already member) is an expected business error; page surfaces it inline.
        showErrors: false,
      },
    ),
  );
}

export async function listAccountInvites(accountId: string) {
  return unwrap(
    await backendApi.get<AccountInvitation[]>(`/accounts/${accountId}/invites`),
  );
}

export async function cancelAccountInvite(accountId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/accounts/${accountId}/invites/${inviteId}`,
    ),
  );
}

export async function resendAccountInvite(accountId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<ResendInviteResult>(
      `/accounts/${accountId}/invites/${inviteId}/resend`,
      {},
    ),
  );
}

export async function describeAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.get<AccountInviteDescribe>(
      `/account-invites/${inviteId}`,
      {
        // The redirect/landing page handles "not for you" / expired states inline.
        showErrors: false,
      },
    ),
  );
}

export async function acceptAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.post<{ account_id: string; account_role: AccountRole }>(
      `/account-invites/${inviteId}/accept`,
      {},
    ),
  );
}

export async function declineAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>(
      `/account-invites/${inviteId}/decline`,
      {},
    ),
  );
}

export async function removeAccountMember(accountId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/accounts/${accountId}/members/${userId}`,
    ),
  );
}

export async function updateAccountMemberRole(
  accountId: string,
  userId: string,
  role: AccountRole,
) {
  return unwrap(
    await backendApi.patch<AccountMember>(
      `/accounts/${accountId}/members/${userId}`,
      { role },
    ),
  );
}

export async function leaveAccount(accountId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>(`/accounts/${accountId}/leave`, {}),
  );
}

/**
 * Server-side / explicit-token variant of {@link listAccounts}. Next.js
 * server actions and route handlers (e.g. the post-signup first-project
 * bootstrap) run per-request and already hold the caller's access token —
 * they must not rely on the SDK's process-wide `configureKortix()` seam.
 * Returns `null` on any failure.
 */
export async function fetchAccountsWithToken(
  opts: ServerTokenOptions,
): Promise<KortixAccount[] | null> {
  return serverTokenGet<KortixAccount[]>(opts, '/v1/accounts');
}

/** The identity `GET /accounts/me` resolves — the authenticated user + their account memberships. */
export interface AccountIdentity {
  user_id: string;
  email: string;
  token_context?: {
    auth_type: string | null;
    project_id: string | null;
    session_id: string | null;
    agent: string | null;
    connectors: 'all' | string[] | null;
    kortix_cli: 'all' | string[] | null;
  };
  accounts: Array<{ account_id: string; slug: string; name: string; role: string }>;
}

export interface ValidateTokenResult {
  valid: boolean;
  identity?: AccountIdentity;
  error?: ApiError;
}

/**
 * The "did I paste a valid API key?" check — hits `GET /accounts/me` and
 * NEVER throws, unlike every other call in this module. Built for a
 * pasted-token UX (a CLI/SDK setup screen) that wants to render "invalid
 * token" inline rather than catch an exception.
 */
export async function validateToken(): Promise<ValidateTokenResult> {
  const res = await backendApi.get<AccountIdentity>('/accounts/me', { showErrors: false });
  if (!res.success || !res.data) {
    return { valid: false, error: res.error };
  }
  return { valid: true, identity: res.data };
}
