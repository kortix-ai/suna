/**
 * Member detail (web parity: accounts/[id]/members/[userId]). Super-admin grant/
 * revoke, an IAM-computed capabilities grid, the groups the member belongs to,
 * and the projects they can reach (with how).
 */

import React, { useMemo, useState } from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Shield, Check, X, Users, FolderGit2, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { listAccountMembers, probeEffectivePermissions } from '@/lib/accounts/accounts-client';
import { listMemberGroups, listMemberProjectAccess, setMemberSuperAdmin } from '@/lib/accounts/iam-client';
import { accountColors, Card, InitialsAvatar, Pill } from '@/components/accounts/account-shared';

const CAPABILITY_GROUPS: { heading: string; items: { label: string; action: string }[] }[] = [
  { heading: 'Account', items: [
    { label: 'Rename account', action: 'account.write' },
    { label: 'Delete account', action: 'account.delete' },
    { label: 'Manage billing', action: 'billing.write' },
    { label: 'Read audit log', action: 'audit.read' },
  ] },
  { heading: 'Members & groups', items: [
    { label: 'Invite members', action: 'member.invite' },
    { label: 'Change member roles', action: 'member.update' },
    { label: 'Remove members', action: 'member.remove' },
    { label: 'Grant super-admin', action: 'member.super_admin.grant' },
    { label: 'Create groups', action: 'group.create' },
    { label: 'Manage policies', action: 'policy.create' },
  ] },
  { heading: 'Projects', items: [
    { label: 'Create projects', action: 'project.create' },
    { label: 'Read every project', action: 'project.read' },
    { label: 'Write every project', action: 'project.write' },
    { label: 'Delete every project', action: 'project.delete' },
  ] },
];
const FLAT_CAPS = CAPABILITY_GROUPS.flatMap((g) => g.items);
const SOURCE_LABEL: Record<string, string> = { implicit: 'account role', direct: 'direct grant', group: 'group' };

export default function MemberDetailScreen() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; userId: string }>();
  const accountId = params.id;
  const userId = params.userId;
  const c = accountColors(isDark);
  const queryClient = useQueryClient();

  const membersQuery = useQuery({ queryKey: ['account-members', accountId], queryFn: () => listAccountMembers(accountId), staleTime: 30_000 });
  const member = useMemo(() => (membersQuery.data ?? []).find((m) => m.user_id === userId), [membersQuery.data, userId]);
  const label = member?.email ?? userId;

  const groupsQuery = useQuery({ queryKey: ['member-groups', accountId, userId], queryFn: () => listMemberGroups(accountId, userId), staleTime: 30_000 });
  const accessQuery = useQuery({ queryKey: ['member-project-access', accountId, userId], queryFn: () => listMemberProjectAccess(accountId, userId), staleTime: 30_000 });
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
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['account-members', accountId] }); queryClient.invalidateQueries({ queryKey: ['member-caps', accountId, userId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update super-admin.'),
  });
  const isSuper = !!member?.is_super_admin;
  const toggleSuper = () => {
    if (isSuper) {
      Alert.alert('Revoke super-admin', `${label} will lose super-admin and be subject to normal IAM checks again.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Revoke', style: 'destructive', onPress: () => { haptics.medium(); setSuper.mutate(false); } },
      ]);
    } else {
      Alert.alert('Grant super-admin', `${label} will bypass every IAM check on this account. Grant only to trusted operators.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Grant', onPress: () => { haptics.medium(); setSuper.mutate(true); } },
      ]);
    }
  };

  const bg = isDark ? '#0D0D0D' : '#FFFFFF';
  const groups = groupsQuery.data ?? [];
  const access = accessQuery.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 8 }}>
        <TouchableOpacity onPress={() => { haptics.tap(); router.back(); }} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginBottom: 10 }}>
          <ChevronLeft size={18} color={c.muted} />
          <Text style={{ fontSize: 13.5, color: c.muted }}>Members</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <InitialsAvatar label={label} isDark={isDark} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: c.fg }} numberOfLines={1}>{label}</Text>
              {isSuper && <Pill label="super" isDark={isDark} tone="amber" />}
            </View>
            {member && <Text style={{ fontSize: 12.5, color: c.muted, marginTop: 1, textTransform: 'capitalize' }}>{member.account_role}</Text>}
          </View>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 48, gap: 16 }} showsVerticalScrollIndicator={false}>
        {/* Super-admin */}
        <Card isDark={isDark}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Shield size={16} color={isSuper ? '#d97706' : c.muted} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Super-admin</Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 2 }}>Bypasses every IAM check on this account. Use sparingly.</Text>
            </View>
            <TouchableOpacity onPress={toggleSuper} disabled={setSuper.isPending} activeOpacity={0.8} style={{ paddingHorizontal: 14, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: isSuper ? 'rgba(239,68,68,0.4)' : c.inputBorder, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}>
              {setSuper.isPending && <ActivityIndicator size="small" color={isSuper ? '#ef4444' : c.fg} />}
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isSuper ? '#ef4444' : c.fg }}>{isSuper ? 'Revoke' : 'Grant'}</Text>
            </TouchableOpacity>
          </View>
        </Card>

        {/* Capabilities */}
        <Card title="What this member can do" description="Computed by the IAM engine — the sum of role, groups, and policies." isDark={isDark}>
          <View style={{ marginTop: 12, gap: 14 }}>
            {CAPABILITY_GROUPS.map((group) => (
              <View key={group.heading}>
                <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>{group.heading}</Text>
                <View style={{ gap: 8 }}>
                  {group.items.map((item) => {
                    const allowed = allowedByAction.get(item.action);
                    return (
                      <View key={item.action} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text style={{ flex: 1, fontSize: 13.5, color: c.fg }}>{item.label}</Text>
                        {capsQuery.isLoading ? (
                          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.avatarBg }} />
                        ) : (
                          <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: allowed ? 'rgba(34,197,94,0.12)' : c.avatarBg }}>
                            {allowed ? <Check size={12} color="#16a34a" /> : <X size={12} color={c.muted} />}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
        </Card>

        {/* Groups */}
        <Card isDark={isDark}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Users size={16} color={c.muted} />
            <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Groups {groups.length}</Text>
          </View>
          <View style={{ marginTop: 12 }}>
            {groupsQuery.isLoading ? <ActivityIndicator size="small" color={c.muted} /> : groups.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: c.muted }}>Not in any group.</Text>
            ) : groups.map((g, i) => (
              <TouchableOpacity key={g.group_id} onPress={() => { haptics.tap(); router.push(`/accounts/${accountId}/groups/${g.group_id}`); }} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <Users size={14} color={c.muted} />
                <Text style={{ flex: 1, fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.name}</Text>
                <ChevronRight size={16} color={c.muted} />
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        {/* Project access */}
        <Card isDark={isDark}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <FolderGit2 size={16} color={c.muted} />
            <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Project access {access.length}</Text>
          </View>
          <View style={{ marginTop: 12 }}>
            {accessQuery.isLoading ? <ActivityIndicator size="small" color={c.muted} /> : access.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: c.muted }}>No project access.</Text>
            ) : access.map((p, i) => (
              <View key={p.project_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{p.project_name}</Text>
                  <Text style={{ fontSize: 11, color: c.muted, marginTop: 1 }}>via {p.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')}</Text>
                </View>
                <Pill label={p.role.charAt(0).toUpperCase() + p.role.slice(1)} isDark={isDark} />
              </View>
            ))}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}
