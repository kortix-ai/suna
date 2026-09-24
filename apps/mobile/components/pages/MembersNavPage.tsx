/**
 * MembersNavPage — the project's members (`page:members`; web parity:
 * customize/sections/members-view). Pushed as a sub-page from project
 * Settings → Customize → Members (`onBack` shows Go back in the header).
 * Restored after COR-160 deleted it (Jay, 2026-09-24: Customize shows
 * Members as an in-app page, not a web handoff).
 *
 * Groups (`SettingsGroup`/`SettingsRow`, tap a row to act in a sheet):
 *   • Pending invites (managers) — emailed invites not yet accepted; the
 *     sheet resends or revokes.
 *   • People — everyone with access. Only a direct project grant is editable
 *     here (change role, revoke); account owners/admins hold Manager by their
 *     account role. Groups are an enterprise feature and have no mobile
 *     surface at all (Jay, 2026-09-24).
 *
 * Invite is the header's `+` and the People group's first row (managers).
 * Confirms use `useConfirmDialog` (never `Alert.alert`); failures use toasts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import {
  UserPlusIcon as UserPlus,
  EnvelopeIcon as Mail,
  ArrowClockwiseIcon as RefreshCw,
  XIcon as X,
  TrashIcon as Trash2,
  type AppIcon,
} from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { PageList } from '@/components/kortix/page-list';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useToast } from '@/components/kortix/toast-provider';
import { useConfirmDialog, type ConfirmRequest } from '@/components/kortix/confirm-dialog';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { THEME } from '@/lib/utils/theme';
import {
  useProject,
  useProjectAccess,
  usePendingProjectInvites,
  useInviteProjectMember,
  useUpdateProjectAccess,
  useRevokeProjectAccess,
  useResendProjectInvite,
  useRevokeProjectInvite,
} from '@/lib/projects/hooks';
import { isInviteSent } from '@/lib/projects/projects-client';
import type {
  ProjectAccessMember,
  ProjectRole,
  PendingProjectInvite,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

const ROLES: ProjectRole[] = ['member', 'manager'];
const ROLE_LABEL: Record<ProjectRole, string> = { member: 'Member', manager: 'Manager' };

interface PageTabLike {
  id: string;
  label: string;
}

interface MembersNavPageProps {
  page: PageTabLike;
  projectId: string;
  /** Pushed as a sub-page of project Settings: Go back in place of the hamburger. */
  onBack?: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

type Confirm = (request: ConfirmRequest) => void;

// ─── helpers ──────────────────────────────────────────────────────────────────

const userLabel = (m: Pick<ProjectAccessMember, 'email' | 'user_id'>) => m.email || m.user_id;
const roleLabel = (role: string) => ROLE_LABEL[role as ProjectRole] ?? role;

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function accountRoleRank(role: string): number {
  return role === 'owner' ? 0 : role === 'admin' ? 1 : role === 'member' ? 2 : 99;
}

/** The role a member holds here, as a row's value. */
function memberRoleLabel(m: ProjectAccessMember): string {
  if (m.has_implicit_access) return ROLE_LABEL.manager;
  return m.effective_project_role ? roleLabel(m.effective_project_role) : 'No access';
}

// ─── row leading slots ────────────────────────────────────────────────────────

/** Leading slot of every row on this page: 28pt, so every label starts on one x. */
const LEADING = 28;

function Avatar({ email }: { email: string | null }) {
  const letter = (email || '?').trim().charAt(0).toUpperCase();
  return (
    <View className="items-center justify-center rounded-full bg-secondary" style={{ width: LEADING, height: LEADING }}>
      <Text variant="small">{letter}</Text>
    </View>
  );
}

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

/** A picker group of the two project roles, the selected one checked. */
function RolePicker({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: ProjectRole | null;
  onChange: (role: ProjectRole) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsGroup title={title}>
      {ROLES.map((r) => (
        <SettingsRow
          key={r}
          label={ROLE_LABEL[r]}
          checked={value === r}
          right={null}
          onPress={disabled ? undefined : () => { haptics.selection(); onChange(r); }}
        />
      ))}
    </SettingsGroup>
  );
}

// ─── sheets ───────────────────────────────────────────────────────────────────

function SheetBody({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <BottomSheetScrollView
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}>
      {children}
    </BottomSheetScrollView>
  );
}

function InviteSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const toast = useToast();
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
      onError: (e: any) => toast.error('Unable to invite', { description: e?.message || 'Try again.' }),
    });
  };

  return (
    <SheetBody>
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
      <RolePicker title="Role" value={role} onChange={setRole} disabled={invite.isPending} />
      <Button size="lg" onPress={submit} disabled={!canSubmit} className="rounded-full">
        <Text>{invite.isPending ? 'Inviting…' : 'Invite'}</Text>
      </Button>
    </SheetBody>
  );
}

function PendingInviteSheet({
  projectId,
  invite,
  onClose,
}: {
  projectId: string;
  invite: PendingProjectInvite;
  onClose: () => void;
}) {
  const toast = useToast();
  const resend = useResendProjectInvite(projectId);
  const revoke = useRevokeProjectInvite(projectId);
  const busy = resend.isPending || revoke.isPending;

  return (
    <SheetBody>
      <SettingsGroup>
        <SettingsRow label="Role" value={roleLabel(invite.project_role)} />
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
              onError: (e: any) => toast.error('Unable to resend', { description: e?.message || 'Try again.' }),
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
              onError: (e: any) => toast.error('Unable to revoke', { description: e?.message || 'Try again.' }),
            });
          }}
        />
      </SettingsGroup>
    </SheetBody>
  );
}

function MemberSheet({
  projectId,
  member,
  onClose,
  confirm,
}: {
  projectId: string;
  member: ProjectAccessMember;
  onClose: () => void;
  confirm: Confirm;
}) {
  const toast = useToast();
  const update = useUpdateProjectAccess(projectId);
  const revoke = useRevokeProjectAccess(projectId);
  const busy = update.isPending || revoke.isPending;
  const done = () => { haptics.success(); onClose(); };

  const changeRole = (role: ProjectRole) => {
    if (role === member.project_role) { onClose(); return; }
    update.mutate({ userId: member.user_id, role }, {
      onSuccess: done,
      onError: (e: any) => toast.error('Unable to change the role', { description: e?.message || 'Try again.' }),
    });
  };
  const doRevoke = () =>
    confirm({
      title: 'Revoke access',
      description: `${userLabel(member)} loses direct access to this project.`,
      confirmLabel: 'Revoke',
      destructive: true,
      onConfirm: () => {
        haptics.medium();
        revoke.mutate(member.user_id, {
          onSuccess: done,
          onError: (e: any) => toast.error('Unable to revoke access', { description: e?.message || 'Try again.' }),
        });
      },
    });

  return (
    <SheetBody>
      <RolePicker title="Project role" value={member.project_role ?? 'member'} onChange={changeRole} disabled={busy} />
      <SettingsGroup>
        <SettingsRow
          icon={Trash2}
          label={revoke.isPending ? 'Revoking…' : 'Revoke access'}
          destructive
          right={null}
          onPress={busy ? undefined : doRevoke}
        />
      </SettingsGroup>
    </SheetBody>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

type SheetState =
  | { kind: 'invite' }
  | { kind: 'pending'; invite: PendingProjectInvite }
  | { kind: 'member'; member: ProjectAccessMember }
  | null;

export function MembersNavPage({
  page,
  projectId,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: MembersNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const projectQuery = useProject(projectId);
  const accessQuery = useProjectAccess(projectId);
  const project = projectQuery.data;
  const canManage = project?.effective_project_role === 'manager' || !!accessQuery.data?.can_manage;
  const invitesQuery = usePendingProjectInvites(projectId, canManage);

  const [sheet, setSheet] = useState<SheetState>(null);
  const sheetRef = React.useRef<BottomSheetModal>(null);
  const open = (s: NonNullable<SheetState>) => { haptics.tap(); setSheet(s); };
  const close = () => sheetRef.current?.dismiss();
  useEffect(() => { if (sheet) sheetRef.current?.present(); }, [sheet]);

  const members = useMemo(
    () =>
      (accessQuery.data?.members ?? [])
        .filter((m) => m.has_implicit_access || m.effective_project_role != null)
        .sort((a, b) => {
          const d = accountRoleRank(a.account_role) - accountRoleRank(b.account_role);
          return d !== 0 ? d : userLabel(a).localeCompare(userLabel(b));
        }),
    [accessQuery.data],
  );
  const pending = canManage ? (invitesQuery.data?.pending ?? []) : [];
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;

  const sheetTitle =
    sheet?.kind === 'invite' ? 'Invite member'
    : sheet?.kind === 'pending' ? sheet.invite.email
    : sheet?.kind === 'member' ? userLabel(sheet.member)
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onBack={onBack}
        onOpenDrawer={onBack ? undefined : onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        onAdd={canManage ? () => open({ kind: 'invite' }) : undefined}
        addLabel="Invite member"
      />

      <PageContent>
        <PageList
          isLoading={accessQuery.isLoading}
          errorMessage={accessQuery.isError && members.length === 0 ? ((accessQuery.error as Error)?.message || 'Unable to load members') : null}
          onRetry={() => void accessQuery.refetch()}
          onRefresh={() => Promise.all([accessQuery.refetch(), canManage ? invitesQuery.refetch() : null])}>
          <View className="gap-6 px-4 pt-1">
            {pending.length > 0 ? (
              <SettingsGroup title="Pending invites">
                {pending.map((inv) => (
                  <SettingsRow
                    key={inv.invite_id}
                    leading={<LeadingIcon icon={Mail} />}
                    label={inv.email}
                    value={inv.invite_expired ? 'Expired' : roleLabel(inv.project_role)}
                    onPress={() => open({ kind: 'pending', invite: inv })}
                  />
                ))}
              </SettingsGroup>
            ) : null}

            <SettingsGroup title="People">
              {canManage ? (
                <SettingsRow leading={<LeadingIcon icon={UserPlus} />} label="Invite member" onPress={() => open({ kind: 'invite' })} />
              ) : null}
              {members.map((m) => {
                // Only a direct project grant is editable here.
                const tappable = canManage && !m.has_implicit_access && !!m.project_role;
                return (
                  <SettingsRow
                    key={m.user_id}
                    leading={<Avatar email={m.email} />}
                    label={userLabel(m)}
                    value={memberRoleLabel(m)}
                    right={tappable ? undefined : NO_CHEVRON}
                    onPress={tappable ? () => open({ kind: 'member', member: m }) : undefined}
                  />
                );
              })}
            </SettingsGroup>

          </View>
        </PageList>
      </PageContent>

      <KortixBottomSheetModal
        ref={sheetRef}
        title={sheetTitle}
        snapPoints={sheet?.kind === 'pending' ? ['42%'] : sheet?.kind === 'invite' ? ['58%'] : ['52%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore">
        {sheet?.kind === 'invite' ? (
          <InviteSheet projectId={projectId} onClose={close} />
        ) : sheet?.kind === 'pending' ? (
          <PendingInviteSheet projectId={projectId} invite={sheet.invite} onClose={close} />
        ) : sheet?.kind === 'member' ? (
          <MemberSheet projectId={projectId} member={sheet.member} onClose={close} confirm={confirm} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>

      {confirmDialog}
    </View>
  );
}
