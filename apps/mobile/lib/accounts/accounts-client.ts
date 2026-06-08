/**
 * Accounts data layer (web parity: lib/projects-client account fns + iam-client).
 *
 * Backs the mobile Account Settings surface — members, invites, IAM permission
 * probing, groups, GitHub connections, audit, and the account-level security /
 * token / observability cards. Reuses the shared apiFetch helper.
 */

import { apiFetch } from '@/lib/projects/projects-client';
import type { AccountRole } from '@/lib/projects/projects-client';

// ── Account + members ─────────────────────────────────────────────────────────

export interface AccountDetail {
  account_id: string;
  name: string;
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
  active_pat_count?: number;
  has_verified_mfa?: boolean;
  joined_at: string;
}

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

export type InviteMemberResult =
  | { status: 'added'; user_id: string; email: string; account_role: AccountRole }
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

const acc = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`;

export function getAccount(accountId: string) {
  return apiFetch<AccountDetail>(acc(accountId));
}

export function updateAccountName(accountId: string, name: string) {
  return apiFetch<AccountDetail>(acc(accountId), { method: 'PATCH', body: JSON.stringify({ name }) });
}

export function listAccountMembers(accountId: string) {
  return apiFetch<AccountMember[]>(`${acc(accountId)}/members`);
}

export function inviteAccountMember(accountId: string, input: { email: string; role?: AccountRole }) {
  return apiFetch<InviteMemberResult>(`${acc(accountId)}/members`, { method: 'POST', body: JSON.stringify(input) });
}

export function listAccountInvites(accountId: string) {
  return apiFetch<AccountInvitation[]>(`${acc(accountId)}/invites`);
}

export function cancelAccountInvite(accountId: string, inviteId: string) {
  return apiFetch<{ ok: boolean }>(`${acc(accountId)}/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
}

export function resendAccountInvite(accountId: string, inviteId: string) {
  return apiFetch<ResendInviteResult>(`${acc(accountId)}/invites/${encodeURIComponent(inviteId)}/resend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function removeAccountMember(accountId: string, userId: string) {
  return apiFetch<{ ok: boolean }>(`${acc(accountId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

export function updateAccountMemberRole(accountId: string, userId: string, role: AccountRole) {
  return apiFetch<AccountMember>(`${acc(accountId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export function leaveAccount(accountId: string) {
  return apiFetch<{ ok: boolean }>(`${acc(accountId)}/leave`, { method: 'POST', body: JSON.stringify({}) });
}

// ── IAM permission probing ────────────────────────────────────────────────────

export type IamResourceType = 'account' | 'project' | 'group' | 'member';

export interface PermissionProbeInput {
  action: string;
  resourceType?: IamResourceType;
  resourceId?: string;
}

export interface PermissionProbeResult {
  action: string;
  resource_type: IamResourceType;
  resource_id: string | null;
  allowed: boolean;
  reason: string | null;
}

/** Batch-probe several IAM actions for a user in one round-trip. Answers come
 *  back in the same order as the input. */
export async function probeEffectivePermissions(accountId: string, userId: string, probes: PermissionProbeInput[]) {
  if (probes.length === 0) return [] as PermissionProbeResult[];
  const res = await apiFetch<{ results: PermissionProbeResult[] }>(
    `${acc(accountId)}/iam/members/${encodeURIComponent(userId)}/effective:batch`,
    { method: 'POST', body: JSON.stringify({ probes }) },
  );
  return res.results;
}

// ── Group membership (bulk add) ───────────────────────────────────────────────

export function addGroupMembers(accountId: string, groupId: string, userIds: string[]) {
  return apiFetch<{ added: number }>(`${acc(accountId)}/iam/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
}
