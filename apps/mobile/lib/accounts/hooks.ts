/**
 * React-query hooks for the Account Settings surface.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAccount,
  updateAccountName,
  listAccountMembers,
  inviteAccountMember,
  listAccountInvites,
  cancelAccountInvite,
  resendAccountInvite,
  removeAccountMember,
  updateAccountMemberRole,
  leaveAccount,
  probeEffectivePermissions,
  addGroupMembers,
  type PermissionProbeInput,
} from './accounts-client';
import type { AccountRole } from '@/lib/projects/projects-client';

export const accountKeys = {
  account: (id: string | null | undefined) => ['account', id] as const,
  members: (id: string | null | undefined) => ['account-members', id] as const,
  invites: (id: string | null | undefined) => ['account-invites', id] as const,
  capabilities: (id: string | null | undefined, userId: string | null | undefined) =>
    ['account-capabilities', id, userId] as const,
};

// ── Queries ───────────────────────────────────────────────────────────────────

export function useAccount(accountId: string | null) {
  return useQuery({
    queryKey: accountKeys.account(accountId),
    queryFn: () => getAccount(accountId!),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useAccountMembers(accountId: string | null) {
  return useQuery({
    queryKey: accountKeys.members(accountId),
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!accountId,
    staleTime: 20_000,
  });
}

export function useAccountInvites(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: accountKeys.invites(accountId),
    queryFn: () => listAccountInvites(accountId!),
    enabled: enabled && !!accountId,
    staleTime: 20_000,
  });
}

/** The capabilities the Account Settings UI gates on, derived from the IAM
 *  engine in a single batch probe. */
const CAPABILITY_ACTIONS = [
  'account.write',
  'account.delete',
  'member.invite',
  'member.remove',
  'member.update',
  'group.create',
  'audit.read',
] as const;

export type AccountCapability = (typeof CAPABILITY_ACTIONS)[number];

export function useAccountCapabilities(accountId: string | null, userId: string | null) {
  const probes: PermissionProbeInput[] = useMemo(() => CAPABILITY_ACTIONS.map((action) => ({ action })), []);
  const query = useQuery({
    queryKey: accountKeys.capabilities(accountId, userId),
    queryFn: () => probeEffectivePermissions(accountId!, userId!, probes),
    enabled: !!accountId && !!userId,
    staleTime: 5 * 60_000,
  });
  const can = useMemo(() => {
    const map = {} as Record<AccountCapability, boolean>;
    for (const a of CAPABILITY_ACTIONS) map[a] = false;
    for (const r of query.data ?? []) {
      if ((CAPABILITY_ACTIONS as readonly string[]).includes(r.action)) {
        map[r.action as AccountCapability] = r.allowed;
      }
    }
    return map;
  }, [query.data]);
  return { can, isLoading: query.isLoading };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useUpdateAccountName(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => updateAccountName(accountId, name),
    onSuccess: (updated) => {
      queryClient.setQueryData(accountKeys.account(accountId), updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

function useInvalidateMembers(accountId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accountKeys.members(accountId) });
    queryClient.invalidateQueries({ queryKey: accountKeys.invites(accountId) });
    queryClient.invalidateQueries({ queryKey: accountKeys.account(accountId) });
  };
}

export function useInviteAccountMember(accountId: string) {
  const invalidate = useInvalidateMembers(accountId);
  return useMutation({
    mutationFn: (input: { email: string; role?: AccountRole }) => inviteAccountMember(accountId, input),
    onSuccess: invalidate,
  });
}

export function useCancelAccountInvite(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId, inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.invites(accountId) }),
  });
}

export function useResendAccountInvite(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => resendAccountInvite(accountId, inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.invites(accountId) }),
  });
}

export function useRemoveAccountMember(accountId: string) {
  const invalidate = useInvalidateMembers(accountId);
  return useMutation({
    mutationFn: (userId: string) => removeAccountMember(accountId, userId),
    onSuccess: invalidate,
  });
}

export function useUpdateAccountMemberRole(accountId: string) {
  const invalidate = useInvalidateMembers(accountId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AccountRole }) =>
      updateAccountMemberRole(accountId, userId, role),
    onSuccess: invalidate,
  });
}

export function useLeaveAccount(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => leaveAccount(accountId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useAddGroupMembers(accountId: string) {
  const invalidate = useInvalidateMembers(accountId);
  return useMutation({
    mutationFn: ({ groupId, userIds }: { groupId: string; userIds: string[] }) =>
      addGroupMembers(accountId, groupId, userIds),
    onSuccess: invalidate,
  });
}
