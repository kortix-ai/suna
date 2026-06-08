/**
 * Account → Groups (web parity: iam/groups-tab). List + search + create + delete
 * groups; tap a group to open its detail (members + project access).
 */

import React, { useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { Search, X, Plus, Users, Trash2, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { listGroups, createGroup, deleteGroup } from '@/lib/accounts/groups-client';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import { Pill, PrimaryButton, SkeletonList, accountColors, type AccountCaps } from './account-shared';

export function GroupsTab({ account, can, isDark }: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const accountId = account.account_id;
  const canCreate = can['group.create'];
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ['account-groups', accountId], queryFn: () => listGroups(accountId), staleTime: 30_000 });
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const createRef = React.useRef<BottomSheetModal>(null);

  const del = useMutation({
    mutationFn: (groupId: string) => deleteGroup(accountId, groupId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to delete group.'),
    onSettled: () => setBusyId(null),
  });

  const filtered = useMemo(() => {
    const all = query.data ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((g) => g.name.toLowerCase().includes(q) || (g.description?.toLowerCase().includes(q) ?? false)) : all;
  }, [query.data, search]);

  const confirmDelete = (groupId: string, name: string) => Alert.alert('Delete group', `Delete "${name}"? Any permission policies attached to this group will be removed.`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(groupId); del.mutate(groupId); } },
  ]);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: c.fg }}>Groups</Text>
          {canCreate && (
            <TouchableOpacity onPress={() => { haptics.tap(); createRef.current?.present(); }} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 11, paddingRight: 13, height: 34, borderRadius: 9999, backgroundColor: theme.primary }}>
              <Plus size={14} color={theme.primaryForeground} />
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Create</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={{ fontSize: 12.5, color: c.muted, marginBottom: 14 }}>Bundle members together and attach the whole group to projects with a role.</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, marginBottom: 14 }}>
          <Search size={15} color={c.muted} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Search by name…" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, fontSize: 14, color: c.fg, fontFamily: 'Roobert', padding: 0 }} />
          {search.length > 0 && <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}><X size={15} color={c.muted} /></TouchableOpacity>}
        </View>

        {query.isLoading ? (
          <SkeletonList count={3} isDark={isDark} />
        ) : query.isError ? (
          <View style={{ paddingVertical: 20, gap: 10 }}>
            <Text style={{ fontSize: 13.5, color: '#ef4444' }}>{(query.error as Error)?.message || 'Failed to load groups'}</Text>
            <TouchableOpacity onPress={() => query.refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text></TouchableOpacity>
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 36, gap: 10 }}>
            <Users size={26} color={c.muted} />
            <Text style={{ fontSize: 13.5, color: c.muted, textAlign: 'center' }}>{search ? 'No groups match your search' : 'No groups yet. Create one to bulk-add members to projects.'}</Text>
          </View>
        ) : (
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, overflow: 'hidden' }}>
            {filtered.map((g, i) => (
              <TouchableOpacity key={g.group_id} onPress={() => { haptics.tap(); router.push(`/accounts/${accountId}/groups/${g.group_id}`); }} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}>
                  <Users size={16} color={c.muted} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.name}</Text>
                    <Pill label={g.source} isDark={isDark} />
                  </View>
                  <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }} numberOfLines={1}>
                    {g.description ? `${g.description} · ` : ''}{g.member_count ?? 0} member{(g.member_count ?? 0) === 1 ? '' : 's'} · {g.project_count ?? 0} project{(g.project_count ?? 0) === 1 ? '' : 's'}
                  </Text>
                </View>
                {canCreate && (busyId === g.group_id ? <ActivityIndicator size="small" color={c.muted} /> : (
                  <TouchableOpacity onPress={() => confirmDelete(g.group_id, g.name)} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 9999, alignItems: 'center', justifyContent: 'center' }}><Trash2 size={14} color="#ef4444" /></TouchableOpacity>
                ))}
                <ChevronRight size={16} color={c.muted} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      <BottomSheetModal
        ref={createRef}
        snapPoints={['52%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <CreateGroupSheet accountId={accountId} isDark={isDark}
          onClose={() => createRef.current?.dismiss()}
          onCreated={(groupId) => { queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] }); createRef.current?.dismiss(); router.push(`/accounts/${accountId}/groups/${groupId}`); }} />
      </BottomSheetModal>
    </View>
  );
}

function CreateGroupSheet({ accountId, onCreated, onClose, isDark }: { accountId: string; onCreated: (groupId: string) => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => createGroup(accountId, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (g) => { haptics.success(); onCreated(g.group_id); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to create group.'),
  });
  const input = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, fontSize: 14, color: c.fg, fontFamily: 'Roobert' as const };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Users size={18} color={c.fg} />
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>Create a group</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12.5, color: c.muted, marginBottom: 16 }}>Groups bundle members together. Attach the group to projects with a role.</Text>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Group name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="Engineering" placeholderTextColor={c.muted} style={input} />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 6 }}>Description (optional)</Text>
        <BottomSheetTextInput value={description} onChangeText={setDescription} placeholder="Engineers shipping the platform" placeholderTextColor={c.muted} style={input} />
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Create group" onPress={() => create.mutate()} disabled={!name.trim() || create.isPending} pending={create.isPending} />
      </View>
    </View>
  );
}
