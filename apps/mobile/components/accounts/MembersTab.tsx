/**
 * Account → Members (web parity: MembersCard + PendingInvitesSection + invite +
 * bulk dialogs). List members, search, invite, change role, remove, leave,
 * pending invites (resend / copy link / cancel), and bulk actions (add to group,
 * change role, remove). Per-member actions open a bottom sheet.
 */

import React, { useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  Search,
  UserPlus,
  Mail,
  Clock,
  RefreshCw,
  Link as LinkIcon,
  X,
  ChevronRight,
  Check,
  KeyRound,
  Shield,
  Trash2,
  Users,
  CircleCheck,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useAccountGroups } from '@/lib/projects/hooks';
import {
  useAccountMembers,
  useAccountInvites,
  useInviteAccountMember,
  useUpdateAccountMemberRole,
  useRemoveAccountMember,
  useLeaveAccount,
  useResendAccountInvite,
  useCancelAccountInvite,
  useAddGroupMembers,
} from '@/lib/accounts/hooks';
import type { AccountDetail, AccountMember } from '@/lib/accounts/accounts-client';
import type { AccountRole } from '@/lib/projects/projects-client';
import {
  accountColors,
  ACCOUNT_ROLE_LABEL,
  InitialsAvatar,
  Pill,
  RolePill,
  PrimaryButton,
  type AccountCaps,
} from './account-shared';

const ACCOUNT_ROLES: AccountRole[] = ['owner', 'admin', 'member'];
const ROLE_BLURB: Record<AccountRole, string> = {
  owner: 'Full control + can delete the account.',
  admin: 'Everything except account deletion.',
  member: 'No implicit project access.',
};

const memberLabel = (m: { email: string | null; user_id: string }) => m.email || m.user_id;

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type SheetState =
  | { kind: 'invite' }
  | { kind: 'member'; member: AccountMember }
  | { kind: 'bulkGroup' }
  | { kind: 'bulkRole' }
  | null;

export function MembersTab({ account, currentUserId, can, isDark }: { account: AccountDetail; currentUserId: string; can: AccountCaps; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
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
  const openSheet = (s: NonNullable<SheetState>) => { setSheet(s); sheetRef.current?.present(); };

  const members = membersQuery.data ?? [];
  const sorted = useMemo(() => {
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };
    const q = search.trim().toLowerCase();
    const f = q ? members.filter((m) => (m.email ?? '').toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q)) : members;
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

  const bulkEligible = useMemo(() => sorted.filter((m) => m.user_id !== currentUserId), [sorted, currentUserId]);
  const effectiveSelected = useMemo(() => {
    const eligible = new Set(bulkEligible.map((m) => m.user_id));
    return new Set([...selectedIds].filter((id) => eligible.has(id)));
  }, [selectedIds, bulkEligible]);
  const selectedCount = effectiveSelected.size;

  const toggleOne = (id: string) => setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => { setSelectedIds(new Set()); setSelectMode(false); };

  // ── per-member actions ──
  const copyInvite = async (url: string) => { haptics.tap(); await Clipboard.setStringAsync(url); Alert.alert('Copied', 'Invite link copied to clipboard.'); };
  const onResend = (id: string) => {
    haptics.tap(); setBusyId(id);
    resend.mutate(id, {
      onSuccess: (res) => Alert.alert(res.email_sent ? 'Invite sent' : 'Email skipped', res.email_sent ? 'The invitation email was sent.' : 'Email delivery is unavailable — copy the invite link to share it manually.'),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to resend invite.'),
      onSettled: () => setBusyId(null),
    });
  };
  const onCancelInvite = (id: string, email: string) => {
    Alert.alert('Cancel invite', `Revoke the pending invite for ${email}?`, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel invite', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(id); cancelInvite.mutate(id, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to cancel invite.'), onSettled: () => setBusyId(null) }); } },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + (selectMode ? 90 : 40) }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Header row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: c.fg }}>
            Members <Text style={{ color: c.muted, fontFamily: 'Roobert' }}>{account.member_count}</Text>
          </Text>
          {canBulk && bulkEligible.length > 0 && (
            <TouchableOpacity onPress={() => { haptics.tap(); setSelectMode((v) => !v); if (selectMode) setSelectedIds(new Set()); }} hitSlop={6}>
              <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: selectMode ? '#ef4444' : c.muted }}>{selectMode ? 'Cancel' : 'Select'}</Text>
            </TouchableOpacity>
          )}
          {canInvite && !selectMode && (
            <TouchableOpacity onPress={() => openSheet({ kind: 'invite' })} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 11, paddingRight: 13, height: 34, borderRadius: 9999, backgroundColor: useThemeColors().primary }}>
              <UserPlus size={14} color={useThemeColors().primaryForeground} />
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: useThemeColors().primaryForeground }}>Invite</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Search */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, marginBottom: 14 }}>
          <Search size={15} color={c.muted} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Search by email…" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, fontSize: 14, color: c.fg, fontFamily: 'Roobert', padding: 0 }} />
          {search.length > 0 && <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}><X size={15} color={c.muted} /></TouchableOpacity>}
        </View>

        {/* Pending invites */}
        {invites.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Pending invites · {invites.length}</Text>
            <View style={{ borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, overflow: 'hidden' }}>
              {invites.map((inv, i) => {
                const busy = busyId === inv.invite_id;
                return (
                  <View key={inv.invite_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(245,158,11,0.14)', alignItems: 'center', justifyContent: 'center' }}>
                      <Mail size={16} color="#d97706" />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{inv.email}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
                        <Clock size={11} color={c.muted} />
                        <Text style={{ fontSize: 11.5, color: c.muted }}>Expires {formatDate(inv.expires_at)}</Text>
                      </View>
                    </View>
                    <RolePill role={inv.initial_role} isDark={isDark} />
                    {busy ? <ActivityIndicator size="small" color={c.muted} /> : canInvite ? (
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity onPress={() => onResend(inv.invite_id)} hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}><RefreshCw size={13} color={c.muted} /></TouchableOpacity>
                        <TouchableOpacity onPress={() => copyInvite(inv.invite_url)} hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}><LinkIcon size={13} color={c.muted} /></TouchableOpacity>
                        <TouchableOpacity onPress={() => onCancelInvite(inv.invite_id, inv.email)} hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center', justifyContent: 'center' }}><X size={13} color="#ef4444" /></TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Members list */}
        {membersQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
        ) : membersQuery.isError ? (
          <View style={{ paddingVertical: 20, gap: 10 }}>
            <Text style={{ fontSize: 13.5, color: '#ef4444' }}>{(membersQuery.error as Error)?.message || 'Failed to load members'}</Text>
            <TouchableOpacity onPress={() => membersQuery.refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text></TouchableOpacity>
          </View>
        ) : sorted.length === 0 ? (
          <Text style={{ fontSize: 13.5, color: c.muted, textAlign: 'center', paddingVertical: 28 }}>{members.length === 0 ? 'No members yet.' : `No members match "${search.trim()}".`}</Text>
        ) : (
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, overflow: 'hidden' }}>
            {sorted.map((m, i) => {
              const isSelf = m.user_id === currentUserId;
              const selectable = selectMode && canBulk && !isSelf;
              const selected = selectedIds.has(m.user_id);
              const onRow = () => {
                if (selectable) { haptics.tap(); toggleOne(m.user_id); return; }
                if (selectMode) return;
                haptics.tap(); openSheet({ kind: 'member', member: m });
              };
              return (
                <TouchableOpacity key={m.user_id} onPress={onRow} activeOpacity={0.6} disabled={selectMode && !selectable} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                  {selectMode && (
                    <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: selectable ? (selected ? useThemeColors().primary : c.inputBorder) : 'transparent', backgroundColor: selected ? useThemeColors().primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                      {selected && <Check size={14} color={useThemeColors().primaryForeground} />}
                    </View>
                  )}
                  <InitialsAvatar label={m.email} isDark={isDark} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{memberLabel(m)}</Text>
                      {isSelf && <Pill label="You" isDark={isDark} />}
                      {m.is_super_admin && <Pill label="super" isDark={isDark} tone="amber" />}
                      {m.has_verified_mfa && <Pill label="2FA" isDark={isDark} tone="emerald" />}
                      {!!m.groups?.length && <Pill label={`${m.groups.length} group${m.groups.length === 1 ? '' : 's'}`} isDark={isDark} />}
                      {!!m.active_pat_count && <Pill label={`${m.active_pat_count} PAT${m.active_pat_count === 1 ? '' : 's'}`} isDark={isDark} />}
                    </View>
                    <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }} numberOfLines={1}>
                      Joined {formatDate(m.joined_at)}
                      {m.account_role === 'member' && typeof m.explicit_project_count === 'number' ? ` · ${m.explicit_project_count} project${m.explicit_project_count === 1 ? '' : 's'}` : ''}
                    </Text>
                  </View>
                  <RolePill role={m.account_role} isDark={isDark} />
                  {!selectMode && <ChevronRight size={16} color={c.muted} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Bulk action bar */}
      {selectMode && selectedCount > 0 && (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 10, paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>{selectedCount} selected</Text>
          <View style={{ flex: 1 }} />
          {canInvite && <TouchableOpacity onPress={() => openSheet({ kind: 'bulkGroup' })} style={{ paddingHorizontal: 12, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: c.border, justifyContent: 'center' }}><Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Group</Text></TouchableOpacity>}
          {canUpdateRole && <TouchableOpacity onPress={() => openSheet({ kind: 'bulkRole' })} style={{ paddingHorizontal: 12, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: c.border, justifyContent: 'center' }}><Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Role</Text></TouchableOpacity>}
          {canRemove && <TouchableOpacity onPress={() => bulkRemove()} style={{ paddingHorizontal: 12, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', justifyContent: 'center' }}><Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Remove</Text></TouchableOpacity>}
        </View>
      )}

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'member' ? ['62%'] : ['52%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {sheet?.kind === 'invite' ? (
          <InviteSheet accountId={accountId} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'member' ? (
          <MemberSheet account={account} member={sheet.member} isSelf={sheet.member.user_id === currentUserId} can={can} sorted={sorted} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'bulkGroup' ? (
          <BulkGroupSheet accountId={accountId} count={selectedCount} onDone={clearSelection} onClose={() => sheetRef.current?.dismiss()} userIds={[...effectiveSelected]} isDark={isDark} />
        ) : sheet?.kind === 'bulkRole' ? (
          <BulkRoleSheet accountId={accountId} count={selectedCount} userIds={[...effectiveSelected]} onDone={clearSelection} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </View>
  );

  function bulkRemove() {
    const ids = [...effectiveSelected];
    Alert.alert('Remove members', `Remove ${ids.length} member${ids.length === 1 ? '' : 's'} from ${account.name}? They lose access immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: `Remove ${ids.length}`, style: 'destructive', onPress: async () => {
        haptics.medium();
        await Promise.allSettled(ids.map((id) => removeMember.mutateAsync(id)));
        clearSelection();
      } },
    ]);
  }
}

// ─── invite sheet ─────────────────────────────────────────────────────────────

function SheetHeader({ title, onClose, isDark, leading }: { title: string; onClose: () => void; isDark: boolean; leading?: React.ReactNode }) {
  const c = accountColors(isDark);
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {leading}
      <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{title}</Text>
      <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
        <X size={17} color={c.muted} />
      </TouchableOpacity>
    </View>
  );
}

function RolePicker({ value, onChange, roles, isDark }: { value: AccountRole; onChange: (r: AccountRole) => void; roles: AccountRole[]; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  return (
    <View>
      {roles.map((r, i) => {
        const sel = value === r;
        return (
          <TouchableOpacity key={r} onPress={() => { haptics.tap(); onChange(r); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: sel ? theme.primary : c.inputBorder, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
              {sel && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.primary }} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>{ACCOUNT_ROLE_LABEL[r]}</Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 2 }}>{ROLE_BLURB[r]}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function InviteSheet({ accountId, onClose, isDark }: { accountId: string; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
  const invite = useInviteAccountMember(accountId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setErr('Enter a valid email address.'); return; }
    setErr(null);
    invite.mutate({ email: trimmed, role }, {
      onSuccess: (res) => {
        haptics.success();
        if (res.status === 'pending') Alert.alert('Invite sent', `Invite sent to ${res.email} — they'll see it when they sign up.`);
        else Alert.alert('Member added', `Added ${res.email}.`);
        onClose();
      },
      onError: (e: any) => setErr(e?.status === 409 ? 'That user is already a member of this account.' : (e?.message || 'Failed to invite member.')),
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title="Invite member" onClose={onClose} isDark={isDark} leading={<UserPlus size={18} color={c.fg} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Email</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12 }}>
          <Mail size={15} color={c.muted} />
          <BottomSheetTextInput value={email} onChangeText={(t) => { setEmail(t); if (err) setErr(null); }} placeholder="teammate@company.com" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={{ flex: 1, fontSize: 14, color: c.fg, fontFamily: 'Roobert', padding: 0 }} />
        </View>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 16, marginBottom: 2 }}>Role</Text>
        <RolePicker value={role} onChange={setRole} roles={['member', 'admin']} isDark={isDark} />
        {err && <View style={{ marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}><Text style={{ fontSize: 13, color: '#ef4444' }}>{err}</Text></View>}
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Invite" onPress={submit} disabled={!email.trim() || invite.isPending} pending={invite.isPending} icon={<UserPlus size={15} color={useThemeColors().primaryForeground} />} />
      </View>
    </View>
  );
}

// ─── member action sheet ──────────────────────────────────────────────────────

function MemberSheet({ account, member, isSelf, can, sorted, onClose, isDark }: { account: AccountDetail; member: AccountMember; isSelf: boolean; can: AccountCaps; sorted: AccountMember[]; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const updateRole = useUpdateAccountMemberRole(account.account_id);
  const removeMember = useRemoveAccountMember(account.account_id);
  const leave = useLeaveAccount(account.account_id);

  const isLastOwner = member.account_role === 'owner' && sorted.filter((m) => m.account_role === 'owner').length === 1;
  const canUpdateRole = can['member.update'] && !isSelf;
  const canRemove = can['member.remove'] && !isSelf;

  const changeRole = (role: AccountRole) => {
    if (role === member.account_role) return;
    haptics.tap();
    updateRole.mutate({ userId: member.user_id, role }, {
      onSuccess: () => { haptics.success(); onClose(); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update role.'),
    });
  };
  const doRemove = () => {
    Alert.alert('Remove member', `Remove ${memberLabel(member)} from ${account.name}? They lose access immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { haptics.medium(); removeMember.mutate(member.user_id, { onSuccess: () => { haptics.success(); onClose(); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to remove member.') }); } },
    ]);
  };
  const doLeave = () => {
    Alert.alert('Leave team', `You'll lose access to ${account.name} and its projects.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => { haptics.medium(); leave.mutate(undefined, { onSuccess: () => { haptics.success(); onClose(); router.replace('/projects'); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to leave team.') }); } },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={memberLabel(member)} onClose={onClose} isDark={isDark} leading={<InitialsAvatar label={member.email} isDark={isDark} size={34} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); router.push(`/accounts/${account.account_id}/members/${member.user_id}`); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13 }}>
          <KeyRound size={16} color={c.muted} />
          <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>View & edit permission policies</Text>
          <ChevronRight size={16} color={c.muted} />
        </TouchableOpacity>

        {canUpdateRole && (
          <>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 2 }}>Account role</Text>
            <RolePicker value={member.account_role} onChange={changeRole} roles={ACCOUNT_ROLES} isDark={isDark} />
          </>
        )}

        {canRemove && (
          <TouchableOpacity onPress={doRemove} disabled={isLastOwner} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', marginTop: 16, opacity: isLastOwner ? 0.4 : 1 }}>
            <Trash2 size={15} color="#ef4444" />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Remove from team</Text>
          </TouchableOpacity>
        )}
        {isSelf && (
          <TouchableOpacity onPress={doLeave} disabled={isLastOwner} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', marginTop: 16, opacity: isLastOwner ? 0.4 : 1 }}>
            <Trash2 size={15} color="#ef4444" />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Leave team</Text>
          </TouchableOpacity>
        )}
        {isLastOwner && <Text style={{ fontSize: 11.5, color: c.muted, textAlign: 'center', marginTop: 8 }}>The last owner can't be removed.</Text>}
      </BottomSheetScrollView>
    </View>
  );
}

// ─── bulk sheets ──────────────────────────────────────────────────────────────

function BulkGroupSheet({ accountId, count, userIds, onDone, onClose, isDark }: { accountId: string; count: number; userIds: string[]; onDone: () => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const groupsQuery = useAccountGroups(accountId, true);
  const addToGroup = useAddGroupMembers(accountId);
  const [groupId, setGroupId] = useState<string | null>(null);
  const groups = groupsQuery.data ?? [];

  const submit = () => {
    if (!groupId) return;
    haptics.tap();
    addToGroup.mutate({ groupId, userIds }, {
      onSuccess: (res) => { haptics.success(); Alert.alert('Added to group', `Added ${res.added} member${res.added === 1 ? '' : 's'} to the group.`); onClose(); onDone(); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to add to group.'),
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={`Add ${count} to a group`} onClose={onClose} isDark={isDark} leading={<Users size={18} color={c.fg} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }} showsVerticalScrollIndicator={false}>
        {groupsQuery.isLoading ? (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
        ) : groups.length === 0 ? (
          <Text style={{ fontSize: 13, color: c.muted, paddingVertical: 8 }}>No groups exist on this account yet. Create one from the Groups tab first.</Text>
        ) : (
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
            {groups.map((g, i) => {
              const sel = groupId === g.group_id;
              return (
                <TouchableOpacity key={g.group_id} onPress={() => { haptics.tap(); setGroupId(g.group_id); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border, backgroundColor: sel ? theme.primaryLight : 'transparent' }}>
                  <Users size={15} color={sel ? theme.primary : c.muted} />
                  <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.name}</Text>
                  {sel && <CircleCheck size={17} color={theme.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </BottomSheetScrollView>
      {groups.length > 0 && (
        <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
          <PrimaryButton label="Add to group" onPress={submit} disabled={!groupId || addToGroup.isPending} pending={addToGroup.isPending} />
        </View>
      )}
    </View>
  );
}

function BulkRoleSheet({ accountId, count, userIds, onDone, onClose, isDark }: { accountId: string; count: number; userIds: string[]; onDone: () => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
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
    onClose(); onDone();
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={`Change role for ${count}`} onClose={onClose} isDark={isDark} leading={<Shield size={18} color={c.fg} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }} showsVerticalScrollIndicator={false}>
        <RolePicker value={role} onChange={setRole} roles={ACCOUNT_ROLES} isDark={isDark} />
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Apply" onPress={submit} disabled={busy} pending={busy} />
      </View>
    </View>
  );
}
