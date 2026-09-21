/**
 * Account → Members (web parity: MembersCard + PendingInvitesSection + invite +
 * bulk dialogs). Settings-list layout: actions group, pending invites, members.
 *
 * - Member row → member detail screen (role, super-admin, permissions, groups,
 *   project access, remove / leave).
 * - Pending invite row → action sheet (resend, copy link, cancel).
 * - Select members → bulk group / role / remove, applied from a group of rows.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import {
  WarningCircleIcon as AlertCircle,
  ListChecksIcon as ListChecks,
  EnvelopeIcon as Mail,
  ArrowClockwiseIcon as RotateCw,
  ShieldIcon as Shield,
  TrashIcon as Trash2,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
} from '@/lib/icons';

import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SearchBar } from '@/components/kortix/SearchBar';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { useAccountGroups } from '@/lib/projects/hooks';
import {
  useAccountMembers,
  useAccountInvites,
  useInviteAccountMember,
  useUpdateAccountMemberRole,
  useRemoveAccountMember,
  useResendAccountInvite,
  useCancelAccountInvite,
  useAddGroupMembers,
} from '@/lib/accounts/hooks';
import type { AccountDetail, AccountInvitation } from '@/lib/accounts/accounts-client';
import type { AccountRole } from '@/lib/projects/projects-client';
import {
  ACCOUNT_ROLE_LABEL,
  ACCOUNT_ROLES,
  SheetCloseButton,
  roleRows,
  type AccountCaps,
} from './account-shared';

const memberLabel = (m: { email: string | null; user_id: string }) => m.email || m.user_id;

type SheetState = { kind: 'invite' } | { kind: 'bulkGroup' } | { kind: 'bulkRole' } | null;

export function MembersTab({
  account,
  currentUserId,
  can,
}: {
  account: AccountDetail;
  currentUserId: string;
  can: AccountCaps;
  /** Unused — kept so the account shell's call site stays valid. */
  isDark?: boolean;
}) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const accountId = account.account_id;

  const membersQuery = useAccountMembers(accountId);
  const invitesQuery = useAccountInvites(accountId, can['member.invite']);
  const resend = useResendAccountInvite(accountId);
  const cancelInvite = useCancelAccountInvite(accountId);
  const removeMember = useRemoveAccountMember(accountId);

  const canInvite = can['member.invite'];
  const canRemove = can['member.remove'];
  const canUpdateRole = can['member.update'];
  const canBulk = canInvite || canUpdateRole || canRemove;

  const [search, setSearch] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const sheetRef = React.useRef<BottomSheetModal>(null);
  // Set the content first, then present on the next commit. Presenting in the
  // same tick as setState races the modal open before its content has rendered,
  // which intermittently showed an empty sheet.
  const openSheet = (s: NonNullable<SheetState>) => setSheet(s);
  useEffect(() => {
    if (sheet) sheetRef.current?.present();
  }, [sheet]);

  const members = membersQuery.data ?? [];
  const sorted = useMemo(() => {
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };
    const q = search.trim().toLowerCase();
    const f = q
      ? members.filter(
          (m) => (m.email ?? '').toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q)
        )
      : members;
    return [...f].sort((a, b) => {
      const r = rank[a.account_role] - rank[b.account_role];
      return r !== 0 ? r : memberLabel(a).localeCompare(memberLabel(b));
    });
  }, [members, search]);

  const invites = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = invitesQuery.data ?? [];
    return q ? all.filter((i) => i.email.toLowerCase().includes(q)) : all;
  }, [invitesQuery.data, search]);

  const bulkEligible = useMemo(
    () => sorted.filter((m) => m.user_id !== currentUserId),
    [sorted, currentUserId]
  );
  const effectiveSelected = useMemo(() => {
    const eligible = new Set(bulkEligible.map((m) => m.user_id));
    return new Set([...selectedIds].filter((id) => eligible.has(id)));
  }, [selectedIds, bulkEligible]);
  const selectedCount = effectiveSelected.size;

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  // ── pending-invite actions ──
  const copyInvite = async (url: string) => {
    haptics.tap();
    await Clipboard.setStringAsync(url);
    Alert.alert('Copied', 'Invite link copied to clipboard.');
  };
  const onResend = (id: string) => {
    haptics.tap();
    setBusyId(id);
    resend.mutate(id, {
      onSuccess: (res) =>
        Alert.alert(
          res.email_sent ? 'Invite sent' : 'Email skipped',
          res.email_sent
            ? 'The invitation email was sent.'
            : 'Email delivery is unavailable. Copy the invite link to share it.'
        ),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to resend invite.'),
      onSettled: () => setBusyId(null),
    });
  };
  const onCancelInvite = (id: string, email: string) => {
    Alert.alert('Cancel invite', `Revoke the pending invite for ${email}?`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel invite',
        style: 'destructive',
        onPress: () => {
          haptics.medium();
          setBusyId(id);
          cancelInvite.mutate(id, {
            onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to cancel invite.'),
            onSettled: () => setBusyId(null),
          });
        },
      },
    ]);
  };
  const onInvitePress = (inv: AccountInvitation) => {
    haptics.tap();
    Alert.alert(inv.email, undefined, [
      { text: 'Resend invite', onPress: () => onResend(inv.invite_id) },
      { text: 'Copy invite link', onPress: () => void copyInvite(inv.invite_url) },
      {
        text: 'Cancel invite',
        style: 'destructive',
        onPress: () => onCancelInvite(inv.invite_id, inv.email),
      },
      { text: 'Close', style: 'cancel' },
    ]);
  };

  const bulkRemove = () => {
    const ids = [...effectiveSelected];
    Alert.alert(
      'Remove members',
      `Remove ${ids.length} member${ids.length === 1 ? '' : 's'} from ${account.name}? They lose access immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Remove ${ids.length}`,
          style: 'destructive',
          onPress: async () => {
            haptics.medium();
            await Promise.allSettled(ids.map((id) => removeMember.mutateAsync(id)));
            clearSelection();
          },
        },
      ]
    );
  };

  const showSelect = canBulk && bulkEligible.length > 0;

  return (
    <View className="flex-1">
      <SettingsPage
        refreshControl={
          <RefreshControl
            refreshing={membersQuery.isRefetching}
            onRefresh={() => {
              void membersQuery.refetch();
              if (can['member.invite']) void invitesQuery.refetch();
            }}
          />
        }
        header={
          members.length > 0 ? (
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder="Search members"
              onClear={() => setSearch('')}
            />
          ) : undefined
        }>
        {(canInvite || showSelect) && (
          <SettingsGroup>
            {canInvite && !selectMode && (
              <SettingsRow
                icon={UserPlus}
                label="Invite member"
                onPress={() => {
                  haptics.tap();
                  openSheet({ kind: 'invite' });
                }}
              />
            )}
            {showSelect && (
              <SettingsRow
                icon={ListChecks}
                label={selectMode ? 'Cancel selection' : 'Select members'}
                right={null}
                onPress={() => {
                  haptics.tap();
                  if (selectMode) clearSelection();
                  else setSelectMode(true);
                }}
              />
            )}
          </SettingsGroup>
        )}

        {selectMode && selectedCount > 0 && (
          <SettingsGroup title={`${selectedCount} selected`}>
            {canInvite && (
              <SettingsRow
                icon={Users}
                label="Add to group"
                onPress={() => {
                  haptics.tap();
                  openSheet({ kind: 'bulkGroup' });
                }}
              />
            )}
            {canUpdateRole && (
              <SettingsRow
                icon={Shield}
                label="Change role"
                onPress={() => {
                  haptics.tap();
                  openSheet({ kind: 'bulkRole' });
                }}
              />
            )}
            {canRemove && (
              <SettingsRow icon={Trash2} label="Remove from account" destructive onPress={bulkRemove} />
            )}
          </SettingsGroup>
        )}

        {invites.length > 0 && (
          <SettingsGroup title="Pending invites">
            {invites.map((inv) => (
              <SettingsRow
                key={inv.invite_id}
                icon={Mail}
                label={inv.email}
                value={busyId === inv.invite_id ? 'Updating…' : ACCOUNT_ROLE_LABEL[inv.initial_role]}
                onPress={canInvite ? () => onInvitePress(inv) : undefined}
              />
            ))}
          </SettingsGroup>
        )}

        {membersQuery.isLoading ? (
          <View className="items-center py-10">
            <KortixLoader />
          </View>
        ) : membersQuery.isError ? (
          <SettingsGroup>
            <SettingsRow
              icon={AlertCircle}
              label={(membersQuery.error as Error)?.message || "Couldn't load members"}
              destructive
            />
            <SettingsRow
              icon={RotateCw}
              label="Try again"
              onPress={() => {
                haptics.tap();
                void membersQuery.refetch();
              }}
            />
          </SettingsGroup>
        ) : sorted.length === 0 ? (
          <Text variant="muted" className="py-10 text-center">
            {members.length === 0 ? 'No members yet.' : `No members match "${search.trim()}".`}
          </Text>
        ) : (
          <SettingsGroup title="Members">
            {sorted.map((m) => {
              const isSelf = m.user_id === currentUserId;
              const selectable = selectMode && canBulk && !isSelf;
              return (
                <SettingsRow
                  key={m.user_id}
                  leading={<Avatar variant="custom" size={28} fallbackText={memberLabel(m)} />}
                  label={isSelf ? `${memberLabel(m)} (you)` : memberLabel(m)}
                  value={ACCOUNT_ROLE_LABEL[m.account_role]}
                  checked={selectable && selectedIds.has(m.user_id)}
                  right={selectMode ? null : undefined}
                  onPress={
                    selectMode
                      ? selectable
                        ? () => {
                            haptics.tap();
                            toggleOne(m.user_id);
                          }
                        : undefined
                      : () => {
                          haptics.tap();
                          router.push(`/accounts/${accountId}/members/${m.user_id}`);
                        }
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
      </SettingsPage>

      <KortixBottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'invite' ? ['62%'] : sheet?.kind === 'bulkRole' ? ['46%'] : ['54%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
>
        {sheet?.kind === 'invite' ? (
          <InviteSheet accountId={accountId} onClose={() => sheetRef.current?.dismiss()} />
        ) : sheet?.kind === 'bulkGroup' ? (
          <BulkGroupSheet
            accountId={accountId}
            count={selectedCount}
            userIds={[...effectiveSelected]}
            onDone={clearSelection}
            onClose={() => sheetRef.current?.dismiss()}
          />
        ) : sheet?.kind === 'bulkRole' ? (
          <BulkRoleSheet
            accountId={accountId}
            count={selectedCount}
            userIds={[...effectiveSelected]}
            onDone={clearSelection}
            onClose={() => sheetRef.current?.dismiss()}
          />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>
    </View>
  );
}

// ─── sheet chrome ─────────────────────────────────────────────────────────────

function SheetTitle({ title, onClose }: { title: string; onClose: () => void }) {
  // The app's one sheet title row: close at the far left, title centred.
  return <SheetTitleRow title={title} onClose={() => { haptics.tap(); onClose(); }} />;
}

function SheetFooter({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>{children}</View>;
}

// ─── invite sheet ─────────────────────────────────────────────────────────────

function InviteSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const invite = useInviteAccountMember(accountId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErr('Enter a valid email address.');
      return;
    }
    setErr(null);
    invite.mutate(
      { email: trimmed, role },
      {
        onSuccess: (res) => {
          haptics.success();
          if (res.status === 'pending')
            Alert.alert('Invite sent', `Invite sent to ${res.email}. They'll see it when they sign up.`);
          else Alert.alert('Member added', `Added ${res.email}.`);
          onClose();
        },
        onError: (e: any) =>
          setErr(
            e?.status === 409
              ? 'That user is already a member of this account.'
              : e?.message || 'Failed to invite member.'
          ),
      }
    );
  };

  return (
    <View className="flex-1">
      <SheetTitle title="Invite member" onClose={onClose} />
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 18 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <SheetTextInput
          value={email}
          onChangeText={(t) => {
            setEmail(t);
            if (err) setErr(null);
          }}
          placeholder="Email address"
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <SettingsGroup title="Role">
          {roleRows({ roles: ['member', 'admin'], value: role, onChange: setRole })}
        </SettingsGroup>
        {err ? (
          <Text variant="muted" className="text-destructive">
            {err}
          </Text>
        ) : null}
      </BottomSheetScrollView>
      <SheetFooter>
        <Button
          size="lg"
          className="rounded-full"
          disabled={!email.trim() || invite.isPending}
          onPress={() => {
            haptics.tap();
            submit();
          }}>
          <Text>{invite.isPending ? 'Sending invite…' : 'Send invite'}</Text>
        </Button>
      </SheetFooter>
    </View>
  );
}

// ─── bulk sheets ──────────────────────────────────────────────────────────────

function BulkGroupSheet({
  accountId,
  count,
  userIds,
  onDone,
  onClose,
}: {
  accountId: string;
  count: number;
  userIds: string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const groupsQuery = useAccountGroups(accountId, true);
  const addToGroup = useAddGroupMembers(accountId);
  const [groupId, setGroupId] = useState<string | null>(null);
  const groups = groupsQuery.data ?? [];

  const submit = () => {
    if (!groupId) return;
    haptics.tap();
    addToGroup.mutate(
      { groupId, userIds },
      {
        onSuccess: (res) => {
          haptics.success();
          Alert.alert('Added to group', `Added ${res.added} member${res.added === 1 ? '' : 's'} to the group.`);
          onClose();
          onDone();
        },
        onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to add to group.'),
      }
    );
  };

  return (
    <View className="flex-1">
      <SheetTitle title={`Add ${count} to a group`} onClose={onClose} />
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}>
        {groupsQuery.isLoading ? (
          <View className="items-center py-8">
            <KortixLoader />
          </View>
        ) : groups.length === 0 ? (
          <Text variant="muted" className="py-10 text-center">
            No groups yet. Create one in the Groups tab.
          </Text>
        ) : (
          <SettingsGroup>
            {groups.map((g) => (
              <SettingsRow
                key={g.group_id}
                icon={Users}
                label={g.name}
                checked={groupId === g.group_id}
                right={null}
                onPress={() => {
                  haptics.tap();
                  setGroupId(g.group_id);
                }}
              />
            ))}
          </SettingsGroup>
        )}
      </BottomSheetScrollView>
      {groups.length > 0 && (
        <SheetFooter>
          <Button
            size="lg"
            className="rounded-full"
            disabled={!groupId || addToGroup.isPending}
            onPress={submit}>
            <Text>{addToGroup.isPending ? 'Adding…' : 'Add to group'}</Text>
          </Button>
        </SheetFooter>
      )}
    </View>
  );
}

function BulkRoleSheet({
  accountId,
  count,
  userIds,
  onDone,
  onClose,
}: {
  accountId: string;
  count: number;
  userIds: string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const updateRole = useUpdateAccountMemberRole(accountId);
  const [role, setRole] = useState<AccountRole>('member');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    haptics.tap();
    setBusy(true);
    const res = await Promise.allSettled(userIds.map((id) => updateRole.mutateAsync({ userId: id, role })));
    setBusy(false);
    const failed = res.filter((r) => r.status === 'rejected').length;
    if (failed) Alert.alert('Partly applied', `${userIds.length - failed} updated, ${failed} failed.`);
    else haptics.success();
    onClose();
    onDone();
  };

  return (
    <View className="flex-1">
      <SheetTitle title={`Change role for ${count}`} onClose={onClose} />
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}>
        <SettingsGroup>{roleRows({ roles: ACCOUNT_ROLES, value: role, onChange: setRole })}</SettingsGroup>
      </BottomSheetScrollView>
      <SheetFooter>
        <Button size="lg" className="rounded-full" disabled={busy} onPress={() => void submit()}>
          <Text>{busy ? 'Applying…' : 'Apply role'}</Text>
        </Button>
      </SheetFooter>
    </View>
  );
}
