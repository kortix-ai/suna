/**
 * Member detail (web parity: accounts/[id]/members/[userId]). Role, super-admin,
 * the IAM-computed capabilities, groups, project access, and remove / leave.
 * Settings-list layout: see apps/mobile/design.md.
 */

import React, { useMemo } from 'react';
import { Alert, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon as Check, GitBranchIcon as FolderGit2, SignOutIcon as LogOut, ShieldWarningIcon as ShieldAlert, UserMinusIcon as UserMinus, UsersIcon as Users, XIcon as X } from '@/lib/icons';

import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import {
  ACCOUNT_ROLE_ICON,
  ACCOUNT_ROLE_LABEL,
  ACCOUNT_ROLES,
  roleRows,
  useEffectiveAccountCaps,
} from '@/components/accounts/account-shared';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { listAccountMembers, probeEffectivePermissions } from '@/lib/accounts/accounts-client';
import { listMemberGroups, listMemberProjectAccess, setMemberSuperAdmin } from '@/lib/accounts/iam-client';
import { useLeaveAccount, useRemoveAccountMember, useUpdateAccountMemberRole } from '@/lib/accounts/hooks';
import type { AccountRole } from '@/lib/projects/projects-client';

const CAPABILITY_GROUPS: { heading: string; items: { label: string; action: string }[] }[] = [
  {
    heading: 'Account',
    items: [
      { label: 'Rename account', action: 'account.write' },
      { label: 'Delete account', action: 'account.delete' },
      { label: 'Manage billing', action: 'billing.write' },
      { label: 'Read audit log', action: 'audit.read' },
    ],
  },
  {
    heading: 'Members and groups',
    items: [
      { label: 'Invite members', action: 'member.invite' },
      { label: 'Change member roles', action: 'member.update' },
      { label: 'Remove members', action: 'member.remove' },
      { label: 'Grant super-admin', action: 'member.super_admin.grant' },
      { label: 'Create groups', action: 'group.create' },
      { label: 'Manage policies', action: 'policy.create' },
    ],
  },
  {
    heading: 'Projects',
    items: [
      { label: 'Create projects', action: 'project.create' },
      { label: 'Read every project', action: 'project.read' },
      { label: 'Write every project', action: 'project.write' },
      { label: 'Delete every project', action: 'project.delete' },
    ],
  },
];
const FLAT_CAPS = CAPABILITY_GROUPS.flatMap((g) => g.items);

export default function MemberDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; userId: string }>();
  const accountId = params.id;
  const userId = params.userId;
  const { user } = useAuthContext();
  const currentUserId = user?.id ?? null;
  const queryClient = useQueryClient();

  const { account, can } = useEffectiveAccountCaps(accountId ?? null, currentUserId);

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });
  const members = membersQuery.data ?? [];
  const member = useMemo(() => members.find((m) => m.user_id === userId), [members, userId]);
  const label = member?.email ?? userId;

  const groupsQuery = useQuery({
    queryKey: ['member-groups', accountId, userId],
    queryFn: () => listMemberGroups(accountId, userId),
    staleTime: 30_000,
  });
  const accessQuery = useQuery({
    queryKey: ['member-project-access', accountId, userId],
    queryFn: () => listMemberProjectAccess(accountId, userId),
    staleTime: 30_000,
  });
  const capsQuery = useQuery({
    queryKey: ['member-caps', accountId, userId],
    queryFn: () => probeEffectivePermissions(accountId, userId, FLAT_CAPS.map((c) => ({ action: c.action }))),
    staleTime: 5 * 60_000,
  });
  const allowedByAction = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of capsQuery.data ?? []) map.set(r.action, r.allowed);
    return map;
  }, [capsQuery.data]);

  const setSuper = useMutation({
    mutationFn: (next: boolean) => setMemberSuperAdmin(accountId, userId, next),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
      queryClient.invalidateQueries({ queryKey: ['member-caps', accountId, userId] });
    },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update super-admin.'),
  });
  const isSuper = !!member?.is_super_admin;
  const toggleSuper = () => {
    if (isSuper) {
      Alert.alert('Revoke super-admin', `${label} will lose super-admin and be subject to normal IAM checks again.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            haptics.medium();
            setSuper.mutate(false);
          },
        },
      ]);
    } else {
      Alert.alert('Grant super-admin', `${label} will bypass every IAM check on this account. Grant only to trusted operators.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Grant',
          onPress: () => {
            haptics.medium();
            setSuper.mutate(true);
          },
        },
      ]);
    }
  };

  const updateRole = useUpdateAccountMemberRole(accountId);
  const removeMember = useRemoveAccountMember(accountId);
  const leave = useLeaveAccount(accountId);

  const isSelf = !!currentUserId && userId === currentUserId;
  const isLastOwner =
    member?.account_role === 'owner' && members.filter((m) => m.account_role === 'owner').length === 1;
  const canUpdateRole = can['member.update'] && !isSelf;
  const canRemove = can['member.remove'] && !isSelf;
  const accountName = account?.name ?? 'this account';

  const changeRole = (role: AccountRole) => {
    if (!member || role === member.account_role) return;
    updateRole.mutate(
      { userId, role },
      {
        onSuccess: () => haptics.success(),
        onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update role.'),
      }
    );
  };
  const doRemove = () => {
    Alert.alert('Remove member', `Remove ${label} from ${accountName}? They lose access immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          haptics.medium();
          removeMember.mutate(userId, {
            onSuccess: () => {
              haptics.success();
              router.back();
            },
            onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to remove member.'),
          });
        },
      },
    ]);
  };
  const doLeave = () => {
    Alert.alert('Leave account', `You'll lose access to ${accountName} and its projects.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          haptics.medium();
          leave.mutate(undefined, {
            onSuccess: () => {
              haptics.success();
              // The start screen re-resolves from fresh accounts, so a last
              // project in the account just left is skipped.
              router.replace('/');
            },
            onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to leave account.'),
          });
        },
      },
    ]);
  };

  const groups = groupsQuery.data ?? [];
  const access = accessQuery.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <SettingsHeader title={label} />

      {membersQuery.isLoading ? (
        <View className="items-center py-16">
          <KortixLoader />
        </View>
      ) : (
        <SettingsPage>
          {member ? (
            <SettingsGroup title="Role">
              {canUpdateRole ? (
                roleRows({ roles: ACCOUNT_ROLES, value: member.account_role, onChange: changeRole })
              ) : (
                <SettingsRow
                  icon={ACCOUNT_ROLE_ICON[member.account_role]}
                  label={ACCOUNT_ROLE_LABEL[member.account_role]}
                />
              )}
            </SettingsGroup>
          ) : null}

          <SettingsGroup title="Access">
            <SettingsRow
              icon={ShieldAlert}
              label="Super-admin"
              right={
                <Switch
                  checked={isSuper}
                  disabled={setSuper.isPending}
                  onCheckedChange={() => toggleSuper()}
                />
              }
            />
          </SettingsGroup>

          {CAPABILITY_GROUPS.map((group) => (
            <SettingsGroup key={group.heading} title={group.heading}>
              {group.items.map((item) => {
                const allowed = allowedByAction.get(item.action) === true;
                return (
                  <SettingsRow
                    key={item.action}
                    leading={
                      capsQuery.isLoading ? (
                        <Skeleton className="h-4 w-4 rounded-sm" />
                      ) : (
                        <Icon
                          as={allowed ? Check : X}
                          size={18}
                          className={allowed ? 'text-foreground/80' : 'text-muted-foreground'}
                        />
                      )
                    }
                    label={item.label}
                  />
                );
              })}
            </SettingsGroup>
          ))}

          <SettingsGroup title="Groups">
            {groupsQuery.isLoading ? (
              <SettingsRow icon={Users} label="Loading groups…" />
            ) : groups.length === 0 ? (
              <SettingsRow icon={Users} label="Not in any group" />
            ) : (
              groups.map((g) => (
                <SettingsRow
                  key={g.group_id}
                  icon={Users}
                  label={g.name}
                  onPress={() => {
                    haptics.tap();
                    router.push(`/accounts/${accountId}/groups/${g.group_id}`);
                  }}
                />
              ))
            )}
          </SettingsGroup>

          <SettingsGroup title="Project access">
            {accessQuery.isLoading ? (
              <SettingsRow icon={FolderGit2} label="Loading projects…" />
            ) : access.length === 0 ? (
              <SettingsRow icon={FolderGit2} label="No project access" />
            ) : (
              access.map((p) => (
                <SettingsRow
                  key={p.project_id}
                  icon={FolderGit2}
                  label={p.project_name}
                  value={p.role.charAt(0).toUpperCase() + p.role.slice(1)}
                />
              ))
            )}
          </SettingsGroup>

          {member && (canRemove || isSelf) ? (
            <SettingsGroup>
              {canRemove && (
                <SettingsRow
                  icon={UserMinus}
                  label="Remove from account"
                  destructive
                  value={isLastOwner ? 'Last owner' : undefined}
                  onPress={isLastOwner ? undefined : doRemove}
                />
              )}
              {isSelf && (
                <SettingsRow
                  icon={LogOut}
                  label="Leave account"
                  destructive
                  value={isLastOwner ? 'Last owner' : undefined}
                  onPress={isLastOwner ? undefined : doLeave}
                />
              )}
            </SettingsGroup>
          ) : null}
        </SettingsPage>
      )}
    </View>
  );
}
