/**
 * Account groups (IAM) data layer — list/create/delete/rename + group detail
 * (members, project grants). Web parity: lib/iam-client.ts group fns.
 */

import { apiFetch } from '@/lib/projects/projects-client';
import type { AccountGroup } from '@/lib/projects/projects-client';

export type { AccountGroup };

export interface GroupMember {
  user_id: string;
  added_at: string;
  added_by: string | null;
}

export interface GroupProjectGrant {
  project_id: string;
  project_name: string;
  role: 'manager' | 'editor' | 'viewer';
  granted_by: string | null;
  created_at: string;
  expires_at?: string | null;
}

const groups = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/iam/groups`;

export async function listGroups(accountId: string) {
  const res = await apiFetch<{ groups: AccountGroup[] }>(groups(accountId));
  return res.groups;
}
export function getGroup(accountId: string, groupId: string) {
  return apiFetch<AccountGroup>(`${groups(accountId)}/${encodeURIComponent(groupId)}`);
}
export function createGroup(accountId: string, input: { name: string; description?: string }) {
  return apiFetch<AccountGroup>(groups(accountId), { method: 'POST', body: JSON.stringify(input) });
}
export function updateGroup(accountId: string, groupId: string, patch: { name?: string; description?: string | null }) {
  return apiFetch<AccountGroup>(`${groups(accountId)}/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteGroup(accountId: string, groupId: string) {
  return apiFetch<{ deleted: boolean }>(`${groups(accountId)}/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
}

export async function listGroupMembers(accountId: string, groupId: string) {
  const res = await apiFetch<{ members: GroupMember[] }>(`${groups(accountId)}/${encodeURIComponent(groupId)}/members`);
  return res.members;
}
export async function listGroupProjectGrants(accountId: string, groupId: string) {
  const res = await apiFetch<{ grants: GroupProjectGrant[] }>(`${groups(accountId)}/${encodeURIComponent(groupId)}/project-grants`);
  return res.grants;
}
