/**
 * Group detail (web parity: accounts/[id]/groups/[groupId]). Rename the group,
 * manage its members, view + detach its project access, delete it.
 * Settings-list layout: see apps/mobile/design.md.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { WarningCircleIcon as AlertCircle, GitBranchIcon as FolderGit2, PencilIcon as Pencil, ArrowClockwiseIcon as RotateCw, TrashIcon as Trash2, UserPlusIcon as UserPlus } from '@/lib/icons';

import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground, KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import {
  getGroup,
  updateGroup,
  deleteGroup,
  listGroupMembers,
  listGroupProjectGrants,
} from '@/lib/accounts/groups-client';
import { listAccountMembers, addGroupMembers } from '@/lib/accounts/accounts-client';
import { detachGroupFromProject, removeGroupMember } from '@/lib/projects/projects-client';
import { SheetCloseButton } from '@/components/accounts/account-shared';

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default function GroupDetailScreen() {
  const sheetBg = useSheetBackground();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; groupId: string }>();
  const accountId = params.id;
  const groupId = params.groupId;
  const queryClient = useQueryClient();

  const groupQuery = useQuery({ queryKey: ['account-group', accountId, groupId], queryFn: () => getGroup(accountId, groupId), staleTime: 30_000 });
  const membersQuery = useQuery({ queryKey: ['group-members', accountId, groupId], queryFn: () => listGroupMembers(accountId, groupId), staleTime: 20_000 });
  const grantsQuery = useQuery({ queryKey: ['group-grants', accountId, groupId], queryFn: () => listGroupProjectGrants(accountId, groupId), staleTime: 20_000 });
  const accountMembersQuery = useQuery({ queryKey: ['account-members', accountId], queryFn: () => listAccountMembers(accountId), staleTime: 30_000 });

  const group = groupQuery.data;
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of accountMembersQuery.data ?? []) if (m.email) map.set(m.user_id, m.email);
    return map;
  }, [accountMembersQuery.data]);

  const update = useMutation({
    mutationFn: (input: { name: string; description: string | null }) => updateGroup(accountId, groupId, input),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['account-group', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      editRef.current?.dismiss();
    },
    onError: (e: any) => Alert.alert('Unable to save group', e?.message || 'Try again in a moment.'),
  });
  const del = useMutation({
    mutationFn: () => deleteGroup(accountId, groupId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); router.back(); },
    onError: (e: any) => Alert.alert('Unable to delete group', e?.message || 'Try again in a moment.'),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => removeGroupMember(accountId, groupId, userId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Unable to remove member', e?.message || 'Try again in a moment.'),
  });
  const detach = useMutation({
    mutationFn: (projectId: string) => detachGroupFromProject(projectId, groupId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['group-grants', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Unable to detach group', e?.message || 'Try again in a moment.'),
  });

  const addRef = React.useRef<BottomSheetModal>(null);
  const editRef = React.useRef<BottomSheetModal>(null);
  const members = membersQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const candidates = useMemo(() => (accountMembersQuery.data ?? []).filter((m) => !memberIds.has(m.user_id)), [accountMembersQuery.data, memberIds]);

  const confirmDelete = () => Alert.alert(`Delete ${group?.name ?? 'group'}?`, 'Permission policies attached to this group are removed too.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete group', style: 'destructive', onPress: () => { haptics.medium(); del.mutate(); } },
  ]);
  const confirmRemove = (userId: string) => Alert.alert('Remove from group?', emailByUserId.get(userId) ?? userId, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { haptics.medium(); removeMember.mutate(userId); } },
  ]);
  const confirmDetach = (projectId: string, projectName: string) => Alert.alert(`Detach from ${projectName}?`, 'Members lose access they inherit through this group.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Detach', style: 'destructive', onPress: () => { haptics.medium(); detach.mutate(projectId); } },
  ]);

  const sheetProps = {
    enableDynamicSizing: false,
    backgroundStyle: { backgroundColor: sheetBg },
    handleIndicatorStyle: sheetHandleIndicatorStyle(isDark),
    backdropComponent: SheetBackdrop,
  } as const;

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <SettingsHeader title={group?.name ?? 'Group'} />

      {groupQuery.isLoading ? (
        <View className="items-center py-12">
          <KortixLoader />
        </View>
      ) : groupQuery.isError || !group ? (
        <SettingsPage>
          <SettingsGroup>
            <SettingsRow icon={AlertCircle} label="Couldn't load group" destructive />
            <SettingsRow icon={RotateCw} label="Try again" right={null} onPress={() => { haptics.tap(); groupQuery.refetch(); }} />
          </SettingsGroup>
        </SettingsPage>
      ) : (
        <SettingsPage>
          <SettingsGroup title="Details">
            <SettingsRow
              icon={Pencil}
              label="Name"
              value={group.name}
              onPress={() => { haptics.tap(); editRef.current?.present(); }}
            />
          </SettingsGroup>

          <SettingsGroup title="Members">
            <SettingsRow
              icon={UserPlus}
              label="Add member"
              right={null}
              onPress={() => { haptics.tap(); addRef.current?.present(); }}
            />
            {members.map((m) => {
              const email = emailByUserId.get(m.user_id) ?? m.user_id;
              return (
                <SettingsRow
                  key={m.user_id}
                  leading={<Avatar variant="custom" size={28} fallbackText={email} />}
                  label={email}
                  right={null}
                  onPress={() => { haptics.selection(); confirmRemove(m.user_id); }}
                />
              );
            })}
          </SettingsGroup>

          {grants.length > 0 && (
            <SettingsGroup title="Project access">
              {grants.map((g) => (
                <SettingsRow
                  key={g.project_id}
                  icon={FolderGit2}
                  label={g.project_name}
                  value={roleLabel(g.role)}
                  right={null}
                  onPress={() => { haptics.selection(); confirmDetach(g.project_id, g.project_name); }}
                />
              ))}
            </SettingsGroup>
          )}

          <SettingsGroup>
            <SettingsRow
              icon={Trash2}
              label={del.isPending ? 'Deleting…' : 'Delete group'}
              destructive
              onPress={del.isPending ? undefined : () => { haptics.tap(); confirmDelete(); }}
            />
          </SettingsGroup>
        </SettingsPage>
      )}

      <KortixBottomSheetModal ref={editRef} snapPoints={['46%']} keyboardBehavior="interactive" keyboardBlurBehavior="restore" {...sheetProps}>
        {group ? (
          <EditGroupSheet
            initialName={group.name}
            initialDescription={group.description ?? ''}
            pending={update.isPending}
            isDark={isDark}
            onClose={() => editRef.current?.dismiss()}
            onSave={(name, description) => update.mutate({ name, description: description || null })}
          />
        ) : null}
      </KortixBottomSheetModal>

      <KortixBottomSheetModal ref={addRef} snapPoints={['72%']} {...sheetProps}>
        <AddMembersSheet
          candidates={candidates.map((m) => ({ user_id: m.user_id, email: m.email }))}
          isDark={isDark}
          onClose={() => addRef.current?.dismiss()}
          onAdd={async (ids) => {
            try {
              await addGroupMembers(accountId, groupId, ids);
              haptics.success();
              queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
              queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
              addRef.current?.dismiss();
            } catch (e: any) {
              Alert.alert('Unable to add members', e?.message || 'Try again in a moment.');
            }
          }}
        />
      </KortixBottomSheetModal>
    </View>
  );
}

function SheetTitle({ title, onClose }: { title: string; onClose: () => void; isDark?: boolean }) {
  // The app's one sheet title row: close at the far left, title centred.
  return <SheetTitleRow title={title} onClose={() => { haptics.tap(); onClose(); }} />;
}

function EditGroupSheet({ initialName, initialDescription, pending, onSave, onClose, isDark }: {
  initialName: string;
  initialDescription: string;
  pending: boolean;
  onSave: (name: string, description: string) => void;
  onClose: () => void;
  isDark: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  useEffect(() => { setName(initialName); setDescription(initialDescription); }, [initialName, initialDescription]);

  const dirty = name.trim() !== initialName || description.trim() !== initialDescription;

  return (
    <View style={{ flex: 1 }}>
      <SheetTitle title="Edit group" onClose={onClose} isDark={isDark} />
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SheetTextInput value={name} onChangeText={setName} placeholder="Group name" accessibilityLabel="Group name" maxLength={128} />
        <SheetTextInput value={description} onChangeText={setDescription} placeholder="Description (optional)" accessibilityLabel="Description" maxLength={256} />
      </BottomSheetScrollView>
      <View className="px-4 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
        <Button
          size="lg"
          className="rounded-full"
          disabled={!name.trim() || !dirty || pending}
          onPress={() => { haptics.tap(); onSave(name.trim(), description.trim()); }}
        >
          <Text>{pending ? 'Saving…' : 'Save'}</Text>
        </Button>
      </View>
    </View>
  );
}

function AddMembersSheet({ candidates, onAdd, onClose, isDark }: { candidates: { user_id: string; email: string | null }[]; onAdd: (ids: string[]) => void; onClose: () => void; isDark: boolean }) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <View style={{ flex: 1 }}>
      <SheetTitle title="Add members" onClose={onClose} isDark={isDark} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        {candidates.length === 0 ? (
          <Text variant="muted" className="py-10 text-center">
            Everyone in this account is already in the group.
          </Text>
        ) : (
          <SettingsGroup>
            {candidates.map((m) => {
              const email = m.email ?? m.user_id;
              return (
                <SettingsRow
                  key={m.user_id}
                  leading={<Avatar variant="custom" size={28} fallbackText={email} />}
                  label={email}
                  checked={selected.has(m.user_id)}
                  right={null}
                  onPress={() => { haptics.selection(); toggle(m.user_id); }}
                />
              );
            })}
          </SettingsGroup>
        )}
      </BottomSheetScrollView>
      {candidates.length > 0 && (
        <View className="px-4 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
          <Button
            size="lg"
            className="rounded-full"
            disabled={selected.size === 0 || busy}
            onPress={() => { haptics.tap(); setBusy(true); onAdd([...selected]); }}
          >
            <Text>{busy ? 'Adding…' : selected.size > 0 ? `Add ${selected.size}` : 'Add'}</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
