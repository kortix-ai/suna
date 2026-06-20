/**
 * MembersNavPage — project membership & access (web parity: customize/sections/
 * members-view).
 *
 * Cards:
 *   • Invite by email — add a Kortix user at a chosen role; non-Kortix emails get
 *     an invitation.
 *   • Pending invitations — emailed invites not yet accepted; resend / revoke.
 *   • Project access — everyone with access: implicit owners/admins (Manager),
 *     direct grants (role change + revoke), and group-inherited members (managed
 *     via the group). Tapping a member opens an action sheet.
 *   • Group access — attach account groups at a role; change role / detach.
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets, design tokens.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  Users,
  UserPlus,
  Mail,
  Shield,
  Clock,
  RefreshCw,
  X,
  ChevronRight,
  Check,
  Trash2,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import {
  useProject,
  useProjectAccess,
  usePendingProjectInvites,
  useProjectGroupGrants,
  useAccountGroups,
  useInviteProjectMember,
  useUpdateProjectAccess,
  useRevokeProjectAccess,
  useResendProjectInvite,
  useRevokeProjectInvite,
  useAttachGroup,
  useUpdateGroupGrant,
  useDetachGroup,
  useRemoveGroupMember,
} from '@/lib/projects/hooks';
import { isInviteSent } from '@/lib/projects/projects-client';
import type {
  ProjectAccessMember,
  ProjectGroupGrant,
  ProjectRole,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

const MONO = 'Menlo';
const ROLES: ProjectRole[] = ['viewer', 'editor', 'manager'];

const ROLE_DESC: Record<ProjectRole, { label: string; blurb: string }> = {
  viewer: { label: 'Viewer', blurb: 'Read-only. See the project, sessions, triggers, and members.' },
  editor: { label: 'Editor', blurb: 'Everything a viewer sees, plus edit the project and run sessions.' },
  manager: { label: 'Manager', blurb: 'Full control — edit the project, invite members, change settings.' },
};

interface PageTabLike { id: string; label: string; icon: string }
interface MembersNavPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const userLabel = (m: Pick<ProjectAccessMember, 'email' | 'user_id'>) => m.email || m.user_id;

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function accountRoleRank(role: string): number {
  return role === 'owner' ? 0 : role === 'admin' ? 1 : role === 'member' ? 2 : 99;
}

function isInheritedFromGroupOnly(m: ProjectAccessMember): boolean {
  return !m.has_implicit_access && !m.project_role && m.effective_project_role !== null && (m.group_sources?.length ?? 0) > 0;
}

function inheritedSummary(m: ProjectAccessMember): string | null {
  if (!isInheritedFromGroupOnly(m)) return null;
  const sources = m.group_sources!;
  const head = sources[0];
  const rest = sources.length - 1;
  const label = ROLE_DESC[m.effective_project_role!].label;
  return rest > 0 ? `Inherited ${label} via ${head.group_name} + ${rest} more` : `Inherited ${label} via ${head.group_name}`;
}

function useColors(isDark: boolean) {
  return {
    fg: isDark ? '#F8F8F8' : '#121215',
    muted: isDark ? '#9b9b9b' : '#6e6e6e',
    border: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    inputBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)',
    inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    cardBg: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
    avatarBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
  };
}

// ─── shared bits ──────────────────────────────────────────────────────────────

function Avatar({ email, isDark, size = 36 }: { email: string | null; isDark: boolean; size?: number }) {
  const c = useColors(isDark);
  const letter = (email || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.42, fontFamily: 'Roobert-Medium', color: c.fg }}>{letter}</Text>
    </View>
  );
}

function RoleBadge({ role, isDark, withShield }: { role: string; isDark: boolean; withShield?: boolean }) {
  const c = useColors(isDark);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: c.inputBorder }}>
      {withShield && <Shield size={11} color={c.muted} />}
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.fg, textTransform: 'capitalize' }}>{role}</Text>
    </View>
  );
}

function CardHeader({ title, description, count, isDark, action }: { title: string; description?: string; count?: number; isDark: boolean; action?: React.ReactNode }) {
  const c = useColors(isDark);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: c.fg }}>{title}</Text>
          {typeof count === 'number' && (
            <View style={{ minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: c.avatarBg, alignItems: 'center' }}>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted }}>{count}</Text>
            </View>
          )}
        </View>
        {description && <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 4 }}>{description}</Text>}
      </View>
      {action}
    </View>
  );
}

function RolePills({ value, onChange, isDark, disabled }: { value: ProjectRole; onChange: (r: ProjectRole) => void; isDark: boolean; disabled?: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {ROLES.map((r) => {
        const active = value === r;
        return (
          <TouchableOpacity key={r} onPress={() => { if (disabled) return; haptics.tap(); onChange(r); }} activeOpacity={0.8} style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9999, borderWidth: 1, borderColor: active ? theme.primary : c.border, backgroundColor: active ? theme.primaryLight : 'transparent', opacity: disabled ? 0.5 : 1 }}>
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: active ? c.fg : c.muted }}>{ROLE_DESC[r].label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Invite card ──────────────────────────────────────────────────────────────

function InviteCard({ projectId, isDark }: { projectId: string; isDark: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  const invite = useInviteProjectMember(projectId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');

  const canSubmit = email.trim().length > 0 && !invite.isPending;
  const submit = () => {
    if (!canSubmit) return;
    haptics.tap();
    invite.mutate({ email: email.trim(), role }, {
      onSuccess: (result) => {
        haptics.success();
        setEmail('');
        if (isInviteSent(result)) {
          Alert.alert('Invitation sent', `Invitation sent to ${result.email}. They'll join this project as ${ROLE_DESC[result.project_role].label} when they sign up.`);
        } else {
          Alert.alert('Member added', 'They now have access to this project.');
        }
      },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to invite member.'),
    });
  };

  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, padding: 16 }}>
      <CardHeader title="Invite by email" description="Add a Kortix user. If they don't have an account yet, they'll get an invitation email." isDark={isDark} />
      <View style={{ marginTop: 12 }}>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="teammate@example.com"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!invite.isPending}
          style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, fontSize: 14, color: c.fg, fontFamily: 'Roobert' }}
        />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 8 }}>Role</Text>
        <RolePills value={role} onChange={setRole} isDark={isDark} disabled={invite.isPending} />
        <TouchableOpacity onPress={submit} disabled={!canSubmit} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, backgroundColor: theme.primary, marginTop: 14, opacity: canSubmit ? 1 : 0.5 }}>
          {invite.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <UserPlus size={15} color={theme.primaryForeground} />}
          <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Invite</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Pending invites card ─────────────────────────────────────────────────────

function PendingInvitesCard({ projectId, isDark }: { projectId: string; isDark: boolean }) {
  const c = useColors(isDark);
  const invitesQuery = usePendingProjectInvites(projectId, true);
  const resend = useResendProjectInvite(projectId);
  const revoke = useRevokeProjectInvite(projectId);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = invitesQuery.data?.pending ?? [];
  if (!invitesQuery.isLoading && pending.length === 0) return null;

  const onResend = (id: string) => {
    haptics.tap();
    setBusyId(id);
    resend.mutate(id, {
      onSuccess: (res) => Alert.alert(res.email_sent ? 'Invite sent' : 'Email skipped', res.email_sent ? 'The invitation email was sent.' : 'Email delivery is unavailable — share the invite link manually.'),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to resend invitation.'),
      onSettled: () => setBusyId(null),
    });
  };
  const onRevoke = (id: string, email: string) => {
    Alert.alert('Revoke invitation?', `The invitation for ${email} will be cancelled.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: () => {
        haptics.medium();
        setBusyId(id);
        revoke.mutate(id, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to revoke invitation.'), onSettled: () => setBusyId(null) });
      } },
    ]);
  };

  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, padding: 16 }}>
      <CardHeader title="Pending invitations" description="Invited by email but not accepted yet." count={pending.length} isDark={isDark} />
      {invitesQuery.isLoading ? (
        <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {pending.map((inv, i) => {
            const busy = busyId === inv.invite_id;
            return (
              <View key={inv.invite_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(245,158,11,0.14)', alignItems: 'center', justifyContent: 'center' }}>
                  <Mail size={16} color="#d97706" />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{inv.email}</Text>
                    <RoleBadge role={inv.project_role} isDark={isDark} />
                  </View>
                  {inv.invite_expired ? (
                    <Text style={{ fontSize: 11.5, color: '#d97706', marginTop: 3 }}>Invite link expired — ask them to request a fresh one</Text>
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
                      <Clock size={11} color={c.muted} />
                      <Text style={{ fontSize: 11.5, color: c.muted }}>Link expires {formatDate(inv.invite_expires_at)}</Text>
                    </View>
                  )}
                </View>
                {busy ? (
                  <ActivityIndicator size="small" color={c.muted} />
                ) : (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity onPress={() => onResend(inv.invite_id)} hitSlop={6} style={{ width: 34, height: 34, borderRadius: 9999, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}>
                      <RefreshCw size={14} color={c.muted} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => onRevoke(inv.invite_id, inv.email)} hitSlop={6} style={{ width: 34, height: 34, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center', justifyContent: 'center' }}>
                      <X size={14} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Project access card ──────────────────────────────────────────────────────

function AccessCard({ projectId, canManage, isDark, onSelectMember }: { projectId: string; canManage: boolean; isDark: boolean; onSelectMember: (m: ProjectAccessMember) => void }) {
  const c = useColors(isDark);
  const accessQuery = useProjectAccess(projectId);

  const members = accessQuery.data?.members ?? [];
  const accessMembers = useMemo(() => members.filter((m) => m.has_implicit_access || m.effective_project_role != null), [members]);
  const sorted = useMemo(() => [...accessMembers].sort((a, b) => {
    const d = accountRoleRank(a.account_role) - accountRoleRank(b.account_role);
    return d !== 0 ? d : userLabel(a).localeCompare(userLabel(b));
  }), [accessMembers]);

  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, padding: 16 }}>
      <CardHeader title="Project access" description="Account owners and admins always have Manager access." count={accessMembers.length} isDark={isDark} />
      {accessQuery.isLoading ? (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
      ) : accessQuery.isError ? (
        <View style={{ paddingVertical: 12, gap: 10 }}>
          <Text style={{ fontSize: 13, color: '#ef4444' }}>{(accessQuery.error as Error)?.message || 'Failed to load access'}</Text>
          <TouchableOpacity onPress={() => accessQuery.refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {sorted.map((m, i) => {
            const inheritedOnly = isInheritedFromGroupOnly(m);
            const summary = inheritedSummary(m);
            const effRole = m.effective_project_role;
            const tappable = canManage && !m.has_implicit_access;
            const subtitle = m.has_implicit_access
              ? 'Implicit account access'
              : summary
                ? summary
                : m.project_role
                  ? `Granted ${formatDate(m.granted_at)}`
                  : 'No project access';
            return (
              <TouchableOpacity
                key={m.user_id}
                disabled={!tappable}
                activeOpacity={0.6}
                onPress={() => { haptics.tap(); onSelectMember(m); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
              >
                <Avatar email={m.email} isDark={isDark} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{userLabel(m)}</Text>
                    <RoleBadge role={m.account_role} isDark={isDark} />
                    {(m.group_sources ?? []).map((g) => (
                      <View key={g.group_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: c.border }}>
                        <Users size={10} color={c.muted} />
                        <Text style={{ fontSize: 10.5, color: c.muted }}>{g.group_name}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }} numberOfLines={1}>{subtitle}</Text>
                </View>
                {m.has_implicit_access ? (
                  <RoleBadge role="Manager" isDark={isDark} withShield />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {effRole && <RoleBadge role={effRole} isDark={isDark} withShield={inheritedOnly} />}
                    {tappable && <ChevronRight size={16} color={c.muted} />}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Group access card ────────────────────────────────────────────────────────

function GroupAccessCard({ projectId, accountId, canManage, isDark, onAttach, onSelectGrant }: { projectId: string; accountId: string; canManage: boolean; isDark: boolean; onAttach: () => void; onSelectGrant: (g: ProjectGroupGrant) => void }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  const grantsQuery = useProjectGroupGrants(projectId);
  const grants = useMemo(() => [...(grantsQuery.data?.grants ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)), [grantsQuery.data]);

  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, padding: 16 }}>
      <CardHeader
        title="Group access"
        description="Attach an account group. Every member of the group gets the chosen role here."
        count={grants.length}
        isDark={isDark}
        action={canManage ? (
          <TouchableOpacity onPress={() => { haptics.tap(); onAttach(); }} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 34, borderRadius: 9999, borderWidth: 1, borderColor: theme.primary }}>
            <UserPlus size={13} color={theme.primary} />
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primary }}>Attach</Text>
          </TouchableOpacity>
        ) : undefined}
      />
      {grantsQuery.isLoading ? (
        <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
      ) : grants.length === 0 ? (
        <Text style={{ fontSize: 12.5, color: c.muted, marginTop: 10 }}>No groups attached yet.</Text>
      ) : (
        <View style={{ marginTop: 8 }}>
          {grants.map((g, i) => (
            <TouchableOpacity
              key={g.group_id}
              disabled={!canManage}
              activeOpacity={0.6}
              onPress={() => { haptics.tap(); onSelectGrant(g); }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
            >
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}>
                <Users size={16} color={c.muted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.group_name}</Text>
                <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }} numberOfLines={1}>
                  Attached {formatDate(g.created_at)}
                  {typeof g.member_count === 'number' ? ` · ${g.member_count} ${g.member_count === 1 ? 'member' : 'members'}` : ''}
                </Text>
              </View>
              <RoleBadge role={g.role} isDark={isDark} />
              {canManage && <ChevronRight size={16} color={c.muted} />}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── sheets ───────────────────────────────────────────────────────────────────

function SheetHeader({ title, onClose, isDark, leading }: { title: string; onClose: () => void; isDark: boolean; leading?: React.ReactNode }) {
  const c = useColors(isDark);
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

function RoleRadioRow({ role, selected, onPress, isDark }: { role: ProjectRole; selected: boolean; onPress: () => void; isDark: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13 }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selected ? theme.primary : c.inputBorder, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        {selected && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.primary }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>{ROLE_DESC[role].label}</Text>
        <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 2 }}>{ROLE_DESC[role].blurb}</Text>
      </View>
    </TouchableOpacity>
  );
}

function MemberSheet({ projectId, accountId, member, onClose, isDark }: { projectId: string; accountId: string | null; member: ProjectAccessMember; onClose: () => void; isDark: boolean }) {
  const c = useColors(isDark);
  const insets = useSafeAreaInsets();
  const update = useUpdateProjectAccess(projectId);
  const revoke = useRevokeProjectAccess(projectId);
  const detach = useDetachGroup(projectId);
  const removeFromGroup = useRemoveGroupMember(projectId, accountId);
  const inheritedOnly = isInheritedFromGroupOnly(member);
  const busy = update.isPending || revoke.isPending || detach.isPending || removeFromGroup.isPending;

  const changeRole = (role: ProjectRole) => {
    if (role === member.project_role) { onClose(); return; }
    haptics.tap();
    update.mutate({ userId: member.user_id, role }, {
      onSuccess: () => { haptics.success(); onClose(); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update access.'),
    });
  };
  const doRevoke = () => {
    Alert.alert('Revoke project access?', `${userLabel(member)} will lose direct access to this project.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke access', style: 'destructive', onPress: () => {
        haptics.medium();
        revoke.mutate(member.user_id, { onSuccess: () => { haptics.success(); onClose(); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to revoke access.') });
      } },
    ]);
  };
  const doDetach = (groupId: string, groupName: string) => {
    Alert.alert('Detach group from project?', `"${groupName}" will be detached. Everyone whose access here comes from this group loses it.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Detach group', style: 'destructive', onPress: () => {
        haptics.medium();
        detach.mutate(groupId, { onSuccess: () => { haptics.success(); onClose(); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to detach group.') });
      } },
    ]);
  };
  const doRemoveFromGroup = (groupId: string, groupName: string) => {
    Alert.alert('Remove from group?', `${userLabel(member)} will be removed from "${groupName}" across the whole account — this affects every project that group can access.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove from group', style: 'destructive', onPress: () => {
        haptics.medium();
        removeFromGroup.mutate({ groupId, userId: member.user_id }, { onSuccess: () => { haptics.success(); onClose(); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to remove from group.') });
      } },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={userLabel(member)} onClose={onClose} isDark={isDark} leading={<Avatar email={member.email} isDark={isDark} size={34} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        {inheritedOnly ? (
          <>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Access via group</Text>
            <Text style={{ fontSize: 13, color: c.fg, marginBottom: 16 }}>
              Has <Text style={{ fontFamily: 'Roobert-Medium' }}>{ROLE_DESC[member.effective_project_role!].label}</Text> access through a group. Manage it below.
            </Text>
            {(member.group_sources ?? []).map((g) => (
              <View key={g.group_id} style={{ marginBottom: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Users size={14} color={c.muted} />
                  <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>{g.group_name}</Text>
                  <RoleBadge role={g.role} isDark={isDark} />
                </View>
                <TouchableOpacity onPress={() => doDetach(g.group_id, g.group_name)} disabled={busy} activeOpacity={0.7} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Detach from this project</Text>
                  <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 1 }}>Removes access for everyone in this group, here only</Text>
                </TouchableOpacity>
                {accountId && (
                  <TouchableOpacity onPress={() => doRemoveFromGroup(g.group_id, g.group_name)} disabled={busy} activeOpacity={0.7} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
                    <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Remove from group</Text>
                    <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 1 }}>Affects every project this group can access</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </>
        ) : (
          <>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Project role</Text>
            <View>
              {ROLES.map((r, i) => (
                <View key={r} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                  <RoleRadioRow role={r} selected={(member.project_role ?? 'editor') === r} onPress={() => changeRole(r)} isDark={isDark} />
                </View>
              ))}
            </View>
            <TouchableOpacity onPress={doRevoke} disabled={busy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', marginTop: 16 }}>
              {revoke.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={15} color="#ef4444" />}
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Revoke access</Text>
            </TouchableOpacity>
          </>
        )}
      </BottomSheetScrollView>
    </View>
  );
}

function AttachGroupSheet({ projectId, accountId, attachedIds, onClose, isDark }: { projectId: string; accountId: string; attachedIds: Set<string>; onClose: () => void; isDark: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const groupsQuery = useAccountGroups(accountId, true);
  const attach = useAttachGroup(projectId);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRole>('editor');

  const available = (groupsQuery.data ?? []).filter((g) => !attachedIds.has(g.group_id));
  const canSubmit = !!groupId && !attach.isPending;
  const submit = () => {
    if (!canSubmit) return;
    haptics.tap();
    attach.mutate({ groupId: groupId!, role }, {
      onSuccess: () => { haptics.success(); onClose(); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to attach group.'),
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title="Attach a group" onClose={onClose} isDark={isDark} leading={<Users size={18} color={c.fg} />} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        {groupsQuery.isLoading ? (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
        ) : available.length === 0 ? (
          <Text style={{ fontSize: 13, color: c.muted, paddingVertical: 8 }}>
            {(groupsQuery.data ?? []).length === 0 ? 'No account groups exist yet. Create one on the account page.' : 'All your groups are already attached.'}
          </Text>
        ) : (
          <>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Group</Text>
            <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
              {available.map((g, i) => {
                const sel = groupId === g.group_id;
                return (
                  <TouchableOpacity key={g.group_id} onPress={() => { haptics.tap(); setGroupId(g.group_id); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border, backgroundColor: sel ? theme.primaryLight : 'transparent' }}>
                    <Users size={15} color={sel ? theme.primary : c.muted} />
                    <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.name}</Text>
                    {sel && <Check size={16} color={theme.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>Role for the whole group</Text>
            <RolePills value={role} onChange={setRole} isDark={isDark} disabled={attach.isPending} />
          </>
        )}
      </BottomSheetScrollView>
      {available.length > 0 && (
        <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
          <TouchableOpacity onPress={submit} disabled={!canSubmit} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 9999, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}>
            {attach.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Attach group</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function GrantSheet({ projectId, grant, onClose, isDark }: { projectId: string; grant: ProjectGroupGrant; onClose: () => void; isDark: boolean }) {
  const c = useColors(isDark);
  const insets = useSafeAreaInsets();
  const update = useUpdateGroupGrant(projectId);
  const detach = useDetachGroup(projectId);
  const busy = update.isPending || detach.isPending;

  const changeRole = (role: ProjectRole) => {
    if (role === grant.role) { onClose(); return; }
    haptics.tap();
    update.mutate({ groupId: grant.group_id, role }, {
      onSuccess: () => { haptics.success(); onClose(); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update role.'),
    });
  };
  const doDetach = () => {
    Alert.alert('Detach group from project?', `"${grant.group_name}" will no longer be attached. Members lose their inherited ${ROLE_DESC[grant.role].label} access (unless granted another way).`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Detach group', style: 'destructive', onPress: () => {
        haptics.medium();
        detach.mutate(grant.group_id, { onSuccess: () => { haptics.success(); onClose(); }, onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to detach group.') });
      } },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={grant.group_name} onClose={onClose} isDark={isDark} leading={<View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}><Users size={16} color={c.muted} /></View>} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Role for the group</Text>
        <View>
          {ROLES.map((r, i) => (
            <View key={r} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
              <RoleRadioRow role={r} selected={grant.role === r} onPress={() => changeRole(r)} isDark={isDark} />
            </View>
          ))}
        </View>
        <TouchableOpacity onPress={doDetach} disabled={busy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', marginTop: 16 }}>
          {detach.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={15} color="#ef4444" />}
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Detach group</Text>
        </TouchableOpacity>
      </BottomSheetScrollView>
    </View>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

type SheetState =
  | { kind: 'member'; member: ProjectAccessMember }
  | { kind: 'attach' }
  | { kind: 'grant'; grant: ProjectGroupGrant }
  | null;

export function MembersNavPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: MembersNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const c = useColors(isDark);

  const projectQuery = useProject(projectId);
  const accessQuery = useProjectAccess(projectId);
  const grantsQuery = useProjectGroupGrants(projectId);
  const project = projectQuery.data;
  const accountId = project?.account_id ?? null;
  const canManage = project?.effective_project_role === 'manager' || !!accessQuery.data?.can_manage;

  const [sheet, setSheet] = useState<SheetState>(null);
  const sheetRef = React.useRef<BottomSheetModal>(null);
  const open = (s: NonNullable<SheetState>) => setSheet(s);
  useEffect(() => { if (sheet) sheetRef.current?.present(); }, [sheet]);

  const attachedIds = useMemo(() => new Set((grantsQuery.data?.grants ?? []).map((g) => g.group_id)), [grantsQuery.data]);
  const bgColor = isDark ? '#090909' : '#FFFFFF';

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: insets.bottom + 48, gap: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View>
            <Text style={{ fontSize: 19, fontFamily: 'Roobert-Medium', color: c.fg }}>Project members</Text>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: c.muted, marginTop: 4 }}>
              Control who can access this project. Account owners and admins always have Manager access.
            </Text>
          </View>

          {canManage && <InviteCard projectId={projectId} isDark={isDark} />}
          {canManage && <PendingInvitesCard projectId={projectId} isDark={isDark} />}

          <AccessCard projectId={projectId} canManage={canManage} isDark={isDark} onSelectMember={(m) => open({ kind: 'member', member: m })} />

          {accountId && (
            <GroupAccessCard
              projectId={projectId}
              accountId={accountId}
              canManage={canManage}
              isDark={isDark}
              onAttach={() => open({ kind: 'attach' })}
              onSelectGrant={(g) => open({ kind: 'grant', grant: g })}
            />
          )}
        </ScrollView>
      </PageContent>

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'grant' ? ['62%'] : sheet?.kind === 'member' ? ['78%'] : ['82%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {sheet?.kind === 'member' ? (
          <MemberSheet projectId={projectId} accountId={accountId} member={sheet.member} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'attach' && accountId ? (
          <AttachGroupSheet projectId={projectId} accountId={accountId} attachedIds={attachedIds} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'grant' ? (
          <GrantSheet projectId={projectId} grant={sheet.grant} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </View>
  );
}
