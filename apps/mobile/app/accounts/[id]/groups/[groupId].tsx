/**
 * Group detail (web parity: accounts/[id]/groups/[groupId]). Rename / delete the
 * group, manage its members (add / remove), and view + detach its project access
 * grants.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import { ChevronLeft, Users, UserPlus, Trash2, Check, X, FolderGit2 } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useAuthContext } from '@/contexts';
import {
  getGroup,
  updateGroup,
  deleteGroup,
  listGroupMembers,
  listGroupProjectGrants,
} from '@/lib/accounts/groups-client';
import { listAccountMembers, addGroupMembers } from '@/lib/accounts/accounts-client';
import { detachGroupFromProject, removeGroupMember } from '@/lib/projects/projects-client';
import { accountColors, InitialsAvatar, Pill, PrimaryButton } from '@/components/accounts/account-shared';

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function GroupDetailScreen() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; groupId: string }>();
  const accountId = params.id;
  const groupId = params.groupId;
  const c = accountColors(isDark);
  const theme = useThemeColors();
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

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => { if (group) { setName(group.name); setDescription(group.description ?? ''); } }, [group]);

  const update = useMutation({
    mutationFn: () => updateGroup(accountId, groupId, { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['account-group', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update group.'),
  });
  const del = useMutation({
    mutationFn: () => deleteGroup(accountId, groupId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); router.back(); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to delete group.'),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => removeGroupMember(accountId, groupId, userId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to remove member.'),
  });
  const detach = useMutation({
    mutationFn: (projectId: string) => detachGroupFromProject(projectId, groupId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['group-grants', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to detach group.'),
  });

  const addRef = React.useRef<BottomSheetModal>(null);
  const members = membersQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const candidates = useMemo(() => (accountMembersQuery.data ?? []).filter((m) => !memberIds.has(m.user_id)), [accountMembersQuery.data, memberIds]);

  const dirty = !!group && (name.trim() !== group.name || (description.trim() || '') !== (group.description ?? ''));
  const bg = isDark ? '#0D0D0D' : '#FFFFFF';
  const input = { height: 44, borderRadius: 9999, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 16, fontSize: 14, color: c.fg, fontFamily: 'Roobert' as const };
  const sectionTitle = { fontSize: 15.5, fontFamily: 'Roobert-Medium' as const, color: c.fg };
  const divider = { height: 1, backgroundColor: c.border, marginVertical: 22 } as const;
  const countBadge = { minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: c.avatarBg, alignItems: 'center' as const };
  const countText = { fontSize: 11, fontFamily: 'Roobert-Medium' as const, color: c.muted };

  const confirmDelete = () => Alert.alert('Delete group', `Delete "${group?.name}"? Any permission policies attached to this group will be removed.`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { haptics.medium(); del.mutate(); } },
  ]);
  const confirmRemove = (userId: string) => Alert.alert('Remove from group', `Remove ${emailByUserId.get(userId) ?? userId} from this group?`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { haptics.medium(); removeMember.mutate(userId); } },
  ]);
  const confirmDetach = (projectId: string, projectName: string) => Alert.alert('Detach from project', `Members lose their inherited access to "${projectName}" (unless granted another way).`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Detach', style: 'destructive', onPress: () => { haptics.medium(); detach.mutate(projectId); } },
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 8 }}>
        <TouchableOpacity onPress={() => { haptics.tap(); router.back(); }} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginBottom: 8 }}>
          <ChevronLeft size={18} color={c.muted} />
          <Text style={{ fontSize: 13.5, color: c.muted }}>Groups</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 22, fontFamily: 'Roobert-Semibold', color: c.fg }} numberOfLines={1}>{group?.name ?? 'Group'}</Text>
          {group && <Pill label={group.source} isDark={isDark} />}
        </View>
      </View>

      {groupQuery.isLoading ? (
        <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
      ) : groupQuery.isError ? (
        <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 14, color: '#ef4444', textAlign: 'center' }}>{(groupQuery.error as Error)?.message || 'Failed to load group'}</Text>
          <TouchableOpacity onPress={() => groupQuery.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: insets.bottom + 48 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* ── Group details ── */}
          <Text style={sectionTitle}>Group details</Text>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 6 }}>Name</Text>
          <TextInput value={name} onChangeText={setName} maxLength={128} placeholderTextColor={c.muted} style={input} />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 12, marginBottom: 6 }}>Description</Text>
          <TextInput value={description} onChangeText={setDescription} maxLength={256} placeholder="Optional" placeholderTextColor={c.muted} style={input} />
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
            <Text style={{ flex: 1, fontSize: 11.5, color: c.muted }}>Created {formatDate(group?.created_at)}</Text>
            <TouchableOpacity onPress={() => dirty && update.mutate()} disabled={!dirty || update.isPending} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, height: 40, borderRadius: 9999, backgroundColor: theme.primary, opacity: dirty && !update.isPending ? 1 : 0.5 }}>
              {update.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save</Text>
            </TouchableOpacity>
          </View>

          <View style={divider} />

          {/* ── Members ── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Users size={16} color={c.muted} />
            <Text style={sectionTitle}>Members</Text>
            <View style={countBadge}><Text style={countText}>{members.length}</Text></View>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => { haptics.tap(); addRef.current?.present(); }} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 11, paddingRight: 13, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: theme.primary }}>
              <UserPlus size={13} color={theme.primary} />
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primary }}>Add</Text>
            </TouchableOpacity>
          </View>
          <View style={{ marginTop: 6 }}>
            {membersQuery.isLoading ? (
              <View style={{ paddingVertical: 14 }}><ActivityIndicator size="small" color={c.muted} /></View>
            ) : members.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: c.muted, paddingVertical: 12 }}>No members yet.</Text>
            ) : members.map((m, i) => (
              <View key={m.user_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <InitialsAvatar label={emailByUserId.get(m.user_id) ?? m.user_id} isDark={isDark} size={32} />
                <Text style={{ flex: 1, fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{emailByUserId.get(m.user_id) ?? m.user_id}</Text>
                <TouchableOpacity onPress={() => confirmRemove(m.user_id)} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 9999, alignItems: 'center', justifyContent: 'center' }}><Trash2 size={14} color="#ef4444" /></TouchableOpacity>
              </View>
            ))}
          </View>

          <View style={divider} />

          {/* ── Project access ── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <FolderGit2 size={16} color={c.muted} />
            <Text style={sectionTitle}>Project access</Text>
            <View style={countBadge}><Text style={countText}>{grants.length}</Text></View>
          </View>
          <Text style={{ fontSize: 12, color: c.muted, marginTop: 4 }}>Projects this group can access and at what role.</Text>
          <View style={{ marginTop: 6 }}>
            {grantsQuery.isLoading ? (
              <View style={{ paddingVertical: 14 }}><ActivityIndicator size="small" color={c.muted} /></View>
            ) : grants.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: c.muted, paddingVertical: 12 }}>Not attached to any project yet.</Text>
            ) : grants.map((g, i) => (
              <View key={g.project_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.project_name}</Text>
                  <Text style={{ fontSize: 11, color: c.muted, marginTop: 1 }}>Attached {formatDate(g.created_at)}</Text>
                </View>
                <Pill label={g.role.charAt(0).toUpperCase() + g.role.slice(1)} isDark={isDark} />
                <TouchableOpacity onPress={() => confirmDetach(g.project_id, g.project_name)} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 9999, alignItems: 'center', justifyContent: 'center' }}><X size={15} color="#ef4444" /></TouchableOpacity>
              </View>
            ))}
          </View>

          <View style={divider} />

          {/* ── Danger ── */}
          <TouchableOpacity onPress={confirmDelete} disabled={del.isPending} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)' }}>
            {del.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={15} color="#ef4444" />}
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Delete group</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 11.5, color: c.muted, textAlign: 'center', marginTop: 8 }}>Removes the group and any policies attached to it.</Text>
        </ScrollView>
      )}

      <BottomSheetModal
        ref={addRef}
        snapPoints={['72%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <AddMembersSheet
          candidates={candidates.map((m) => ({ user_id: m.user_id, email: m.email }))}
          isDark={isDark}
          onClose={() => addRef.current?.dismiss()}
          onAdd={async (ids) => {
            try { await addGroupMembers(accountId, groupId, ids); haptics.success(); queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] }); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); addRef.current?.dismiss(); }
            catch (e: any) { Alert.alert('Failed', e?.message || 'Failed to add members.'); }
          }}
        />
      </BottomSheetModal>
    </View>
  );
}

function AddMembersSheet({ candidates, onAdd, onClose, isDark }: { candidates: { user_id: string; email: string | null }[]; onAdd: (ids: string[]) => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <UserPlus size={18} color={c.fg} />
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>Add members</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        {candidates.length === 0 ? (
          <Text style={{ fontSize: 13, color: c.muted, paddingVertical: 8 }}>Every account member is already in this group.</Text>
        ) : (
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
            {candidates.map((m, i) => {
              const sel = selected.has(m.user_id);
              return (
                <TouchableOpacity key={m.user_id} onPress={() => { haptics.tap(); toggle(m.user_id); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border, backgroundColor: sel ? theme.primaryLight : 'transparent' }}>
                  <InitialsAvatar label={m.email} isDark={isDark} size={30} />
                  <Text style={{ flex: 1, fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{m.email ?? m.user_id}</Text>
                  {sel && <Check size={17} color={theme.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </BottomSheetScrollView>
      {candidates.length > 0 && (
        <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
          <PrimaryButton label={selected.size > 0 ? `Add ${selected.size}` : 'Add'} onPress={() => { setBusy(true); onAdd([...selected]); }} disabled={selected.size === 0 || busy} pending={busy} />
        </View>
      )}
    </View>
  );
}
