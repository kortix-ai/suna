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
import { View, Pressable, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import {
  UsersIcon as Users,
  UserPlusIcon as UserPlus,
  EnvelopeIcon as Mail,
  ShieldIcon as Shield,
  ClockIcon as Clock,
  ArrowClockwiseIcon as RefreshCw,
  XIcon as X,
  CaretRightIcon as ChevronRight,
  CheckIcon as Check,
  TrashIcon as Trash2,
  type AppIcon,
} from '@/lib/icons';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import {
  BOTTOM_FADE_HEIGHT,
  BottomFade,
  TopFade,
  useScrollFade,
} from '@/components/kortix/scroll-fade';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/kortix/toast-provider';
import Animated from 'react-native-reanimated';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
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
  PendingProjectInvite,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';

const MONO = 'Menlo';
const ROLES: ProjectRole[] = ['member', 'manager'];

const ROLE_DESC: Record<ProjectRole, { label: string; blurb: string }> = {
  member: { label: 'Member', blurb: 'Read, run sessions and chat, and fire the project’s triggers.' },
  manager: { label: 'Manager', blurb: 'Full control — edit the project, invite members, change settings.' },
};

interface PageTabLike { id: string; label: string }
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

function useColors(isDark: boolean) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  return {
    fg,
    muted: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground,
    destructive: isDark ? THEME.dark.destructive : THEME.light.destructive,
    border: withAlpha(fg, 0.08),
    inputBorder: withAlpha(fg, isDark ? 0.1 : 0.12),
    inputBg: withAlpha(fg, isDark ? 0.05 : 0.03),
    cardBg: withAlpha(fg, isDark ? 0.02 : 0.015),
    avatarBg: withAlpha(fg, isDark ? 0.08 : 0.06),
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

function RolePills({ value, onChange, isDark, disabled }: { value: ProjectRole; onChange: (r: ProjectRole) => void; isDark: boolean; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {ROLES.map((r) => {
        const active = value === r;
        return (
          <Button
            key={r}
            variant={active ? 'secondary' : 'outline'}
            onPress={() => { if (disabled) return; haptics.tap(); onChange(r); }}
            disabled={disabled}
            className="flex-1 rounded-full"
          >
            <Text>{ROLE_DESC[r].label}</Text>
          </Button>
        );
      })}
    </View>
  );
}

// ─── Invite card ──────────────────────────────────────────────────────────────

// ─── Invite (a sheet, opened by the header's `+`) ────────────────────────────

function InviteSheet({ projectId, onClose }: { projectId: string; onClose: () => void; isDark: boolean }) {
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const invite = useInviteProjectMember(projectId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');

  const canSubmit = email.trim().length > 0 && !invite.isPending;
  const submit = () => {
    if (!canSubmit) return;
    haptics.tap();
    invite.mutate({ email: email.trim(), role }, {
      onSuccess: (result) => {
        haptics.success();
        toast.success(isInviteSent(result) ? `Invitation sent to ${result.email}` : 'Member added');
        onClose();
      },
      onError: (e: any) => toast.error(e?.message || 'Unable to invite. Try again.'),
    });
  };

  return (
    <View className="flex-1">
      <SheetTitleRow title="Invite member" onClose={() => { haptics.tap(); onClose(); }} />
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <SheetTextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="email-address"
          returnKeyType="send"
          onSubmitEditing={submit}
          editable={!invite.isPending}
        />
        <SettingsGroup title="Role">
          {ROLES.map((r) => (
            <SettingsRow
              key={r}
              label={ROLE_DESC[r].label}
              checked={role === r}
              right={null}
              onPress={invite.isPending ? undefined : () => { haptics.selection(); setRole(r); }}
            />
          ))}
        </SettingsGroup>
        <Button size="lg" onPress={submit} disabled={!canSubmit} className="rounded-full">
          <Text>{invite.isPending ? 'Inviting…' : 'Invite'}</Text>
        </Button>
      </BottomSheetScrollView>
    </View>
  );
}

// ─── Pending invite actions (a sheet) ─────────────────────────────────────────

function PendingInviteSheet({
  projectId,
  invite,
  onClose,
}: {
  projectId: string;
  invite: PendingProjectInvite;
  onClose: () => void;
  isDark: boolean;
}) {
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const resend = useResendProjectInvite(projectId);
  const revoke = useRevokeProjectInvite(projectId);
  const busy = resend.isPending || revoke.isPending;

  return (
    <View className="flex-1">
      <SheetTitleRow title={invite.email} onClose={() => { haptics.tap(); onClose(); }} />
      <View className="gap-4 px-4 pt-1" style={{ paddingBottom: insets.bottom + 24 }}>
        <SettingsGroup>
          <SettingsRow label="Role" value={ROLE_DESC[invite.project_role]?.label ?? invite.project_role} />
          <SettingsRow
            label={invite.invite_expired ? 'Link expired' : 'Link expires'}
            value={invite.invite_expired ? undefined : formatDate(invite.invite_expires_at)}
          />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow
            icon={RefreshCw}
            label={resend.isPending ? 'Sending…' : 'Resend invitation'}
            right={null}
            onPress={busy ? undefined : () => {
              haptics.tap();
              resend.mutate(invite.invite_id, {
                onSuccess: (res) => {
                  toast.success(res.email_sent ? 'Invitation sent' : 'Email is unavailable. Share the link yourself.');
                  onClose();
                },
                onError: (e: any) => toast.error(e?.message || 'Unable to resend. Try again.'),
              });
            }}
          />
          <SettingsRow
            icon={X}
            label={revoke.isPending ? 'Revoking…' : 'Revoke invitation'}
            destructive
            right={null}
            onPress={busy ? undefined : () => {
              haptics.medium();
              revoke.mutate(invite.invite_id, {
                onSuccess: onClose,
                onError: (e: any) => toast.error(e?.message || 'Unable to revoke. Try again.'),
              });
            }}
          />
        </SettingsGroup>
      </View>
    </View>
  );
}

// ─── Page sections: one titled group of rows each ─────────────────────────────

/** Leading slot of every row on this page: 28pt, so every label starts on one x. */
const LEADING = 28;

/** An icon in the avatar's 28pt circle, for a row that has no person. */
function LeadingIcon({ icon }: { icon: AppIcon }) {
  return (
    <View className="items-center justify-center rounded-full bg-secondary" style={{ width: LEADING, height: LEADING }}>
      <Icon as={icon} size={15} className="text-foreground/80" />
    </View>
  );
}

/** Holds the chevron's 16pt slot on a row that does not open, so every value ends on one x. */
const NO_CHEVRON = <View style={{ width: 16 }} />;

/** The role a member holds here, as a row's value. */
function memberRoleLabel(m: ProjectAccessMember): string {
  if (m.has_implicit_access) return ROLE_DESC.manager.label;
  const role = m.effective_project_role;
  return role ? (ROLE_DESC[role]?.label ?? role) : 'No access';
}

function PendingGroup({ projectId, onSelect }: { projectId: string; onSelect: (invite: PendingProjectInvite) => void }) {
  const invitesQuery = usePendingProjectInvites(projectId, true);
  const pending = invitesQuery.data?.pending ?? [];
  if (pending.length === 0) return null;
  return (
    <SettingsGroup title="Pending invites">
      {pending.map((inv) => (
        <SettingsRow
          key={inv.invite_id}
          leading={<LeadingIcon icon={Mail} />}
          label={inv.email}
          value={inv.invite_expired ? 'Expired' : (ROLE_DESC[inv.project_role]?.label ?? inv.project_role)}
          onPress={() => { haptics.tap(); onSelect(inv); }}
        />
      ))}
    </SettingsGroup>
  );
}

function PeopleGroup({
  projectId,
  canManage,
  isDark,
  onInvite,
  onSelectMember,
}: {
  projectId: string;
  canManage: boolean;
  isDark: boolean;
  onInvite: () => void;
  onSelectMember: (m: ProjectAccessMember) => void;
}) {
  const accessQuery = useProjectAccess(projectId);
  const members = accessQuery.data?.members ?? [];
  const sorted = useMemo(
    () =>
      members
        .filter((m) => m.has_implicit_access || m.effective_project_role != null)
        .sort((a, b) => {
          const d = accountRoleRank(a.account_role) - accountRoleRank(b.account_role);
          return d !== 0 ? d : userLabel(a).localeCompare(userLabel(b));
        }),
    [members],
  );

  if (accessQuery.isLoading) {
    return (
      <View className="gap-3">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
      </View>
    );
  }
  if (accessQuery.isError && sorted.length === 0) {
    return (
      <View className="items-center gap-4 pt-10">
        <Text variant="muted" className="text-center">
          {(accessQuery.error as Error)?.message || 'Unable to load members'}
        </Text>
        <Button variant="secondary" size="lg" className="rounded-full" onPress={() => void accessQuery.refetch()}>
          <Text>Try again</Text>
        </Button>
      </View>
    );
  }
  return (
    <SettingsGroup title="People">
      {/* Invite is here too, not only behind the header's `+`: for an owner
          with no one else in the project, it is the one thing to do. */}
      {canManage ? (
        <SettingsRow leading={<LeadingIcon icon={UserPlus} />} label="Invite member" onPress={() => { haptics.tap(); onInvite(); }} />
      ) : null}
      {sorted.map((m) => {
        // Account owners and admins hold Manager here by their account role: nothing to edit.
        const tappable = canManage && !m.has_implicit_access;
        return (
          <SettingsRow
            key={m.user_id}
            leading={<Avatar email={m.email} isDark={isDark} size={LEADING} />}
            label={userLabel(m)}
            value={memberRoleLabel(m)}
            right={tappable ? undefined : NO_CHEVRON}
            onPress={tappable ? () => { haptics.tap(); onSelectMember(m); } : undefined}
          />
        );
      })}
    </SettingsGroup>
  );
}

function GroupsGroup({
  projectId,
  canManage,
  onAttach,
  onSelectGrant,
}: {
  projectId: string;
  canManage: boolean;
  onAttach: () => void;
  onSelectGrant: (g: ProjectGroupGrant) => void;
}) {
  const grantsQuery = useProjectGroupGrants(projectId);
  const grants = useMemo(
    () => [...(grantsQuery.data?.grants ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [grantsQuery.data],
  );
  if (grantsQuery.isLoading || (grants.length === 0 && !canManage)) return null;
  return (
    <SettingsGroup title="Groups">
      {grants.map((g) => (
        <SettingsRow
          key={g.group_id}
          leading={<LeadingIcon icon={Users} />}
          label={g.group_name}
          value={ROLE_DESC[g.role as ProjectRole]?.label ?? g.role}
          right={canManage ? undefined : NO_CHEVRON}
          onPress={canManage ? () => { haptics.tap(); onSelectGrant(g); } : undefined}
        />
      ))}
      {canManage ? (
        <SettingsRow leading={<LeadingIcon icon={UserPlus} />} label="Attach a group" onPress={() => { haptics.tap(); onAttach(); }} />
      ) : null}
    </SettingsGroup>
  );
}

// ─── sheets ───────────────────────────────────────────────────────────────────

function SheetHeader({ title, onClose }: { title: string; onClose: () => void; isDark?: boolean; leading?: React.ReactNode }) {
  // The app's one sheet title row: close at the far left, title centred.
  return <SheetTitleRow title={title} onClose={() => { haptics.tap(); onClose(); }} />;
}

function RoleRadioRow({ role, selected, onPress, isDark }: { role: ProjectRole; selected: boolean; onPress: () => void; isDark: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  return (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13 }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selected ? theme.primary : c.inputBorder, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        {selected && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.primary }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>{ROLE_DESC[role].label}</Text>
        <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 2 }}>{ROLE_DESC[role].blurb}</Text>
      </View>
    </Pressable>
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
                  <Icon as={Users} size={14} color={c.muted} />
                  <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>{g.group_name}</Text>
                  <RoleBadge role={g.role} isDark={isDark} />
                </View>
                <Pressable onPress={() => doDetach(g.group_id, g.group_name)} disabled={busy} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Detach from this project</Text>
                  <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 1 }}>Removes access for everyone in this group, here only</Text>
                </Pressable>
                {accountId && (
                  <Pressable onPress={() => doRemoveFromGroup(g.group_id, g.group_name)} disabled={busy} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
                    <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: c.destructive }}>Remove from group</Text>
                    <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 1 }}>Affects every project this group can access</Text>
                  </Pressable>
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
                  <RoleRadioRow role={r} selected={(member.project_role ?? 'member') === r} onPress={() => changeRole(r)} isDark={isDark} />
                </View>
              ))}
            </View>
            <Button size="lg" variant="outline" onPress={doRevoke} disabled={busy} className="mt-4 rounded-full">
              {revoke.isPending ? <ActivityIndicator size="small" color={c.destructive} /> : <Icon as={Trash2} size={15} color={c.destructive} />}
              <Text style={{ color: c.destructive }}>Revoke access</Text>
            </Button>
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
  const [role, setRole] = useState<ProjectRole>('member');

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
      <SheetHeader title="Attach a group" onClose={onClose} isDark={isDark} leading={<Icon as={Users} size={18} color={c.fg} />} />
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
                  <Pressable key={g.group_id} onPress={() => { haptics.tap(); setGroupId(g.group_id); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border, backgroundColor: sel ? theme.primaryLight : 'transparent' }}>
                    <Icon as={Users} size={15} color={sel ? theme.primary : c.muted} />
                    <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{g.name}</Text>
                    {sel && <Icon as={Check} size={16} color={theme.primary} />}
                  </Pressable>
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
          <Button size="lg" onPress={submit} disabled={!canSubmit} className="rounded-full">
            {attach.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
            <Text>Attach group</Text>
          </Button>
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
      <SheetHeader title={grant.group_name} onClose={onClose} isDark={isDark} leading={<View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}><Icon as={Users} size={16} color={c.muted} /></View>} />
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Role for the group</Text>
        <View>
          {ROLES.map((r, i) => (
            <View key={r} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
              <RoleRadioRow role={r} selected={grant.role === r} onPress={() => changeRole(r)} isDark={isDark} />
            </View>
          ))}
        </View>
        <Button size="lg" variant="outline" onPress={doDetach} disabled={busy} className="mt-4 rounded-full">
          {detach.isPending ? <ActivityIndicator size="small" color={c.destructive} /> : <Icon as={Trash2} size={15} color={c.destructive} />}
          <Text style={{ color: c.destructive }}>Detach group</Text>
        </Button>
      </BottomSheetScrollView>
    </View>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

type SheetState =
  | { kind: 'invite' }
  | { kind: 'pending'; invite: PendingProjectInvite }
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
  const scrollFade = useScrollFade();

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
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        onAdd={canManage ? () => { haptics.tap(); open({ kind: 'invite' }); } : undefined}
        addLabel="Invite member"
      />

      <PageContent>
        <View className="flex-1">
          <Animated.ScrollView
            className="flex-1"
            onScroll={scrollFade.onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: BOTTOM_FADE_HEIGHT + insets.bottom, gap: 18 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            {canManage ? <PendingGroup projectId={projectId} onSelect={(invite) => open({ kind: 'pending', invite })} /> : null}
            <PeopleGroup
              projectId={projectId}
              canManage={canManage}
              isDark={isDark}
              onInvite={() => open({ kind: 'invite' })}
              onSelectMember={(m) => open({ kind: 'member', member: m })}
            />
            {accountId ? (
              <GroupsGroup
                projectId={projectId}
                canManage={canManage}
                onAttach={() => open({ kind: 'attach' })}
                onSelectGrant={(g) => open({ kind: 'grant', grant: g })}
              />
            ) : null}
          </Animated.ScrollView>
          <TopFade style={scrollFade.topFadeStyle} />
          <BottomFade />
        </View>
      </PageContent>

      <KortixBottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'pending' ? ['42%'] : sheet?.kind === 'invite' ? ['58%'] : sheet?.kind === 'grant' ? ['62%'] : sheet?.kind === 'member' ? ['78%'] : ['82%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        {sheet?.kind === 'invite' ? (
          <InviteSheet projectId={projectId} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'pending' ? (
          <PendingInviteSheet projectId={projectId} invite={sheet.invite} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'member' ? (
          <MemberSheet projectId={projectId} accountId={accountId} member={sheet.member} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'attach' && accountId ? (
          <AttachGroupSheet projectId={projectId} accountId={accountId} attachedIds={attachedIds} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : sheet?.kind === 'grant' ? (
          <GrantSheet projectId={projectId} grant={sheet.grant} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>
    </View>
  );
}
