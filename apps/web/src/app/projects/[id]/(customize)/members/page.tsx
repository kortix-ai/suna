'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, use, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Mail, Shield, UserPlus, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import {
  getProject,
  inviteProjectMember,
  isInviteSent,
  listPendingProjectInvites,
  listProjectAccess,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  attachGroupToProject,
  detachGroupFromProject,
  listProjectGroupGrants,
  updateProjectGroupGrant,
  type ProjectAccessMember,
  type ProjectGroupGrant,
  type ProjectRole,
} from '@/lib/projects-client';
import { listGroups, type AccountGroup } from '@/lib/iam-client';
import {
  inheritedFromGroupSummary,
  isInheritedFromGroupOnly,
} from '@/components/iam/iam-display-helpers';
import { PROJECT_ROLE_DESCRIPTORS } from '@/components/iam/project-role-descriptors';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';

// Backwards-compat alias — keep using PROJECT_ROLE_LABEL.<role> in places
// that only need the bare label (badges, "X gets Manager via account role"
// strings). Sourced from the same descriptor as the dropdown subtitles so
// renaming a role is a one-file change.
const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  manager: PROJECT_ROLE_DESCRIPTORS.manager.label,
  editor: PROJECT_ROLE_DESCRIPTORS.editor.label,
  viewer: PROJECT_ROLE_DESCRIPTORS.viewer.label,
};

function userLabel(member: Pick<ProjectAccessMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProjectMembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <MembersView projectId={projectId} />;
}

export function MembersView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader icon={Users} title="Members" />
      <ProjectMembersBody projectId={projectId} />
    </div>
  );
}

function ProjectMembersBody({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });

  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });

  const project = projectQuery.data;
  const canManage = project?.effective_project_role === 'manager' || accessQuery.data?.can_manage;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line92JsxTextProjectMembers')}</h2>
            <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line94JsxTextControlWhoCanAccessThisProjectAccountOwners')}</p>
          </div>
          {/* Answers Marko's "what does a Viewer/Editor/Manager actually
              do?" right at the point of decision — same popover the
              account settings page uses, driven by the shared descriptor. */}
          <PermissionsHelpPopover triggerLabel="Role help" align="end" />
        </header>

        {canManage && <InviteMemberCard projectId={projectId} />}

        {canManage && <PendingInvitesCard projectId={projectId} />}

        <ProjectAccessCard
          projectId={projectId}
          canManage={!!canManage}
          members={accessQuery.data?.members ?? []}
          isLoading={accessQuery.isLoading}
          isError={accessQuery.isError}
          error={accessQuery.error as Error | null}
          onRetry={() => accessQuery.refetch()}
        />

        {project?.account_id && (
          <ProjectGroupGrantsCard
            projectId={projectId}
            accountId={project.account_id}
            canManage={!!canManage}
          />
        )}
      </div>
    </div>
  );
}

function InviteMemberCard({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');

  const inviteMutation = useMutation({
    mutationFn: () => inviteProjectMember(projectId, email.trim(), role),
    onSuccess: (result) => {
      // Two cases. If the email already had a Kortix account, the
      // backend granted them the role immediately and returned the
      // ProjectAccessMember row. If not, the backend created an
      // org-level invitation carrying the project grant — the user
      // won't show up in the access list until they accept.
      if (isInviteSent(result)) {
        toast.success(
          `Invitation sent to ${result.email}. They'll land on this project as ${result.project_role} when they sign up.`,
        );
        // Make the new pending row visible immediately — without this
        // the page looked unchanged after invite, which was the exact
        // confusion that prompted this card to exist.
        queryClient.invalidateQueries({ queryKey: ['project-pending-invites', projectId] });
      } else {
        toast.success('Member added');
        queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }
      setEmail('');
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to invite member'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || inviteMutation.isPending) return;
    inviteMutation.mutate();
  }

  return (
    <SectionCard
      title={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line140JsxAttrTitleInviteByEmail')}
      description="Add a Kortix user to this project. If they don't have an account yet, they'll get an invitation email — accepting puts them on this project at the chosen role in one step."
    >
      {/* Layout: labels on top row, controls on the row below. Stacking
          the labels separately (rather than putting Label+control in
          each column) means we don't have to chase column-height parity
          with sm:items-end — every control just sits on the same
          baseline because they're in a single grid row. */}
      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-[1fr_10rem_auto]"
      >
        <Label htmlFor="invite-email" className="sm:col-start-1">Email</Label>
        <Label htmlFor="invite-role" className="hidden sm:block sm:col-start-2">
          Role
        </Label>
        {/* No label above the button — invisible placeholder keeps the
            grid row's intrinsic height stable without rendering text. */}
        <span aria-hidden className="hidden sm:block sm:col-start-3">&nbsp;</span>

        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line151JsxAttrPlaceholderTeammateExampleCom')}
          disabled={inviteMutation.isPending}
          autoComplete="off"
          className="sm:col-start-1"
          style={{ height: 44 }}
        />

        <Label htmlFor="invite-role-mobile" className="sm:hidden">Role</Label>
        <Select
          value={role}
          onValueChange={(next) => setRole(next as ProjectRole)}
          disabled={inviteMutation.isPending}
        >
          {/* Inline height guarantees parity with Input regardless of
              whether the size="lg" variant has been picked up by --hot
              reload yet (Bun was hitting that issue earlier). */}
          <SelectTrigger
            id="invite-role"
            size="lg"
            className="w-full sm:col-start-2"
            style={{ height: 44 }}
          >
            <SelectValue />
          </SelectTrigger>
          {/* Two-line options (role + capability blurb) so the picker
              explains what each role does. Trigger stays one line —
              see role-select-item.tsx for how the ItemText split works. */}
          <SelectContent>
            <ProjectRoleSelectItem role="viewer" />
            <ProjectRoleSelectItem role="editor" />
            <ProjectRoleSelectItem role="manager" />
          </SelectContent>
        </Select>

        <Button
          type="submit"
          size="lg"
          disabled={!email.trim() || inviteMutation.isPending}
          className="shrink-0 gap-1.5 sm:col-start-3"
          style={{ height: 44 }}
        >
          {inviteMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          Invite
        </Button>
      </form>
    </SectionCard>
  );
}

function ProjectAccessCard({
  projectId,
  canManage,
  members,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  projectId: string;
  canManage: boolean;
  members: ProjectAccessMember[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  // Set rather than scalar so cycling roles on row A while a revoke
  // on row B is still in flight doesn't make the spinner jump.
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const markPending = (userId: string) =>
    setPendingUserIds((prev) => new Set(prev).add(userId));
  const clearPending = (userId: string) =>
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  // Confirmation modal target. Holds the member chosen for revocation
  // until the user confirms — picking "No access" from the dropdown is
  // a destructive action and previously fired without warning, which
  // made it easy to lock someone out by misclicking.
  const [revokeTarget, setRevokeTarget] = useState<ProjectAccessMember | null>(null);

  const sortedMembers = useMemo(() => {
    const rank = { owner: 0, admin: 1, member: 2 };
    return [...members].sort((a, b) => {
      const roleDelta = rank[a.account_role] - rank[b.account_role];
      if (roleDelta !== 0) return roleDelta;
      return userLabel(a).localeCompare(userLabel(b));
    });
  }, [members]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  };

  const updateMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      updateProjectAccess(projectId, userId, role),
    onMutate: ({ userId }) => markPending(userId),
    onSettled: (_data, _error, vars) => clearPending(vars.userId),
    onSuccess: () => {
      toast.success('Access updated');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to update access'),
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => markPending(userId),
    onSettled: (_data, _error, userId) => clearPending(userId),
    onSuccess: () => {
      toast.success('Access revoked');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to revoke access'),
  });

  function setRole(member: ProjectAccessMember, value: string) {
    if (member.has_implicit_access || !canManage) return;
    if (value === 'none') {
      // Stash the target; ConfirmDialog below picks it up. We DON'T
      // fire the mutation here — the dropdown will visually snap back
      // to the prior role on next render since the underlying data
      // hasn't changed, so cancel = no-op without manual state reset.
      setRevokeTarget(member);
      return;
    }
    updateMutation.mutate({ userId: member.user_id, role: value as ProjectRole });
  }

  return (
    <>
    <SectionCard
      flush
      title={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line260JsxAttrTitleProjectAccess')}
      description={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line261JsxAttrDescriptionAccountOwnersAndAdminsAlwaysHaveManagerAccess')}
      count={members.length}
    >
      {isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-8 w-32" />
            </div>
          ))}
        </div>
      )}

      {isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">{error?.message || 'Failed to load access'}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !isError && (
        <List>
          {sortedMembers.map((member) => {
            const busy = pendingUserIds.has(member.user_id);
            const value = member.project_role ?? (member.has_implicit_access ? 'manager' : 'none');
            // Group-derived access — at least one project_group_grants
            // row attaches a group this user belongs to. When this is the
            // ONLY access path (no direct grant), the dropdown will say
            // "No access" but the user actually has the group role; the
            // subtitle below makes that explicit and the badge in the
            // trailing slot mirrors the effective role.
            // Pure helpers in iam-display-helpers, unit-tested.
            const inheritedFromGroup = isInheritedFromGroupOnly(member);
            const inheritedSummary = inheritedFromGroupSummary(member);

            return (
              <ListRow
                key={member.user_id}
                leading={<UserAvatar email={member.email ?? ''} size="md" />}
                title={userLabel(member)}
                badges={<AccountRoleBadge role={member.account_role} />}
                subtitle={
                  <InlineMeta>
                    <span>
                      {member.has_implicit_access
                        ? 'Implicit account access'
                        : inheritedSummary
                          ? inheritedSummary
                          : member.project_role
                            ? `Granted ${formatDate(member.granted_at)}`
                            : 'No project access'}
                    </span>
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : member.has_implicit_access ? (
                    <Badge variant="outline" size="sm">
                      <Shield className="mr-1 h-3.5 w-3.5" />
                      Manager
                    </Badge>
                  ) : inheritedFromGroup ? (
                    // Read-only effective-role chip + a smaller secondary
                    // select for admins who want to LAYER a direct grant
                    // on top (which only matters if it would be higher
                    // than the inherited role). Most of the time the
                    // chip is the whole story.
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" size="sm" className="capitalize">
                        <Shield className="mr-1 h-3.5 w-3.5" />
                        {member.effective_project_role}
                      </Badge>
                      {canManage && (
                        <Select
                          value={value}
                          onValueChange={(next) => setRole(member, next)}
                          disabled={!canManage}
                        >
                          {/* w-40 fits "No direct grant" without
                              truncation — the previous w-32 was clipping
                              to "No direct gran". */}
                          <SelectTrigger className="h-8 w-40 text-xs">
                            <SelectValue placeholder="Grant…" />
                          </SelectTrigger>
                          {/* Same two-line layout as the invite form
                              picker so admins layering a direct grant
                              see what each role does without leaving
                              the row. */}
                          <SelectContent>
                            <SelectItem value="none">No direct grant</SelectItem>
                            <ProjectRoleSelectItem role="viewer" />
                            <ProjectRoleSelectItem role="editor" />
                            <ProjectRoleSelectItem role="manager" />
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ) : (
                    <Select
                      value={value}
                      onValueChange={(next) => setRole(member, next)}
                      disabled={!canManage}
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line328JsxTextNoAccess')}</SelectItem>
                        <ProjectRoleSelectItem role="viewer" />
                        <ProjectRoleSelectItem role="editor" />
                        <ProjectRoleSelectItem role="manager" />
                      </SelectContent>
                    </Select>
                  )
                }
              />
            );
          })}
        </List>
      )}
    </SectionCard>

    <ConfirmDialog
      open={revokeTarget !== null}
      onOpenChange={(open) => {
        if (!open) setRevokeTarget(null);
      }}
      title="Revoke project access?"
      description={
        revokeTarget ? (
          <span>
            <strong>{userLabel(revokeTarget)}</strong> will lose direct
            access to this project. If they belong to a group that's
            attached here, they'll still see the project at the group's
            role.
          </span>
        ) : null
      }
      confirmLabel="Revoke access"
      confirmVariant="destructive"
      isPending={revokeMutation.isPending}
      onConfirm={() => {
        if (!revokeTarget) return;
        const target = revokeTarget;
        // Close the dialog optimistically — the mutation's onSuccess
        // toast is enough feedback, and leaving the modal open while
        // it fires looks janky.
        setRevokeTarget(null);
        revokeMutation.mutate(target.user_id);
      }}
    />
    </>
  );
}

function AccountRoleBadge({ role }: { role: ProjectAccessMember['account_role'] }) {
  return (
    <Badge
      variant="outline"
      size="sm"
      className={role === 'owner' ? 'capitalize border-foreground/30 text-foreground' : 'capitalize'}
    >
      {role}
    </Badge>
  );
}

// ─── Pending invitations (non-Kortix users who haven't signed up yet) ─────
//
// Bridges the gap between "I invited foo@example.com" and "foo joined the
// project". Without this card, the page looks identical before and after
// a successful invite to a non-Kortix email — the inviter has no way to
// recall who they queued up, resend the link, or take it back. Mirrors
// the "Pending invitations" pattern in GitHub / Slack / Linear member
// settings.

function PendingInvitesCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['project-pending-invites', projectId];
  // Set rather than scalar — multiple rapid revokes shouldn't make the
  // spinner jump between rows. Each row tracks its own pending state.
  const [pendingInviteIds, setPendingInviteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const markPending = (id: string) =>
    setPendingInviteIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingInviteIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  // Revoking an invitation is destructive (and may cancel the whole
  // org-level invite when this was the only bootstrap_grant) — gate
  // behind a confirmation.
  const [revokeTarget, setRevokeTarget] = useState<{ inviteId: string; email: string } | null>(null);

  const invitesQuery = useQuery({
    queryKey,
    queryFn: () => listPendingProjectInvites(projectId),
    staleTime: 20_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markPending(inviteId),
    onSettled: (_data, _error, inviteId) => clearPending(inviteId),
    onSuccess: (result) => {
      toast.success(
        result.invitation_cancelled
          ? 'Invitation cancelled.'
          : 'Project access removed from invitation.',
      );
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to revoke invitation'),
  });

  const pending = invitesQuery.data?.pending ?? [];

  // Hide the entire card when empty — no point adding visual noise.
  // (Different from group grants card which always shows an empty state
  // because it has a primary action affordance in the header.)
  if (!invitesQuery.isLoading && pending.length === 0) return null;

  return (
    <>
    <SectionCard
      flush
      title="Pending invitations"
      description="People you've invited by email who haven't accepted yet. They'll join the project at the chosen role as soon as they sign up."
      count={pending.length}
    >
      {invitesQuery.isLoading && (
        <div className="px-6 py-5">
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {!invitesQuery.isLoading && pending.length > 0 && (
        <List>
          {pending.map((invite) => {
            const busy = pendingInviteIds.has(invite.invite_id);
            return (
              <ListRow
                key={invite.invite_id}
                leading={
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    <Mail className="h-4 w-4" />
                  </span>
                }
                title={invite.email}
                badges={
                  <Badge variant="outline" size="sm" className="capitalize">
                    {invite.project_role}
                  </Badge>
                }
                subtitle={
                  <InlineMeta>
                    <span>Invited {formatDate(invite.created_at)}</span>
                    {invite.invited_by_email && (
                      <span>by {invite.invited_by_email}</span>
                    )}
                    {invite.invite_expired ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        Invite link expired — ask them to request a fresh
                        one from the email
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Link expires {formatDate(invite.invite_expires_at)}
                      </span>
                    )}
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevokeTarget({ inviteId: invite.invite_id, email: invite.email })}
                      title="Cancel this invitation"
                      className="gap-1.5"
                    >
                      <X className="h-3.5 w-3.5" />
                      Revoke
                    </Button>
                  )
                }
              />
            );
          })}
        </List>
      )}
    </SectionCard>

    <ConfirmDialog
      open={revokeTarget !== null}
      onOpenChange={(open) => {
        if (!open) setRevokeTarget(null);
      }}
      title="Revoke invitation?"
      description={
        revokeTarget ? (
          <span>
            The invitation for <strong>{revokeTarget.email}</strong> will
            be cancelled. If they were only invited to this project,
            the whole invitation is removed. To resend later you'd need
            to invite them again.
          </span>
        ) : null
      }
      confirmLabel="Revoke invitation"
      confirmVariant="destructive"
      isPending={revokeMutation.isPending}
      onConfirm={() => {
        if (!revokeTarget) return;
        const target = revokeTarget;
        setRevokeTarget(null);
        revokeMutation.mutate(target.inviteId);
      }}
    />
    </>
  );
}

// ─── IAM V2: Group attachments ─────────────────────────────────────────────

function ProjectGroupGrantsCard({
  projectId,
  accountId,
  canManage,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const grantsKey = ['project-group-grants', projectId];

  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => listProjectGroupGrants(projectId),
    staleTime: 20_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });

  const grants = grantsQuery.data?.grants ?? [];
  const groups: AccountGroup[] = groupsQuery.data ?? [];
  const attachedIds = useMemo(() => new Set(grants.map((g) => g.group_id)), [grants]);
  const available = useMemo(
    () => groups.filter((g) => !attachedIds.has(g.group_id)),
    [groups, attachedIds],
  );

  const [pickerGroupId, setPickerGroupId] = useState<string>('');
  const [pickerRole, setPickerRole] = useState<ProjectRole>('editor');
  // Set rather than scalar — attach, update, and detach can each be
  // in-flight on different rows at the same time without the spinner
  // jumping to whatever was last written.
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const markPending = (id: string) =>
    setPendingGroupIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingGroupIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  // Detaching a group revokes inherited access for every group member
  // in one shot — easily a dozen users at once. Always confirm.
  const [detachTarget, setDetachTarget] = useState<ProjectGroupGrant | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    // Attaching, detaching, or re-roling a group changes the EFFECTIVE
    // access of every member of that group on this project. Without
    // these the Members card above shows stale data — a user might
    // appear as "No project access" right after their group was just
    // attached at Editor, until the user manually refetches. Same for
    // the project header (effective_project_role for the current user).
    queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  }

  const attachMutation = useMutation({
    mutationFn: () => attachGroupToProject(projectId, pickerGroupId, pickerRole),
    // Snapshot pickerGroupId at call-time so onSettled can clear the
    // correct row even if the picker changes before the request lands.
    onMutate: () => { markPending(pickerGroupId); return { groupId: pickerGroupId }; },
    onSettled: (_data, _error, _vars, ctx) => clearPending(ctx!.groupId),
    onSuccess: () => {
      toast.success('Group attached');
      setPickerGroupId('');
      setPickerRole('editor');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to attach group'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { groupId: string; role: ProjectRole }) =>
      updateProjectGroupGrant(projectId, input.groupId, input.role),
    onMutate: (input) => markPending(input.groupId),
    onSettled: (_data, _error, input) => clearPending(input.groupId),
    onSuccess: () => {
      toast.success('Role updated');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update role'),
  });

  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (groupId) => markPending(groupId),
    onSettled: (_data, _error, groupId) => clearPending(groupId),
    onSuccess: () => {
      toast.success('Group detached');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to detach group'),
  });

  return (
    <>
    <SectionCard
      flush
      title="Group access"
      description="Attach an account group to this project. Every member of the group gets the chosen role here."
      count={grants.length}
      action={
        canManage && available.length > 0 ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pickerGroupId || attachMutation.isPending) return;
              attachMutation.mutate();
            }}
          >
            <Select
              value={pickerGroupId}
              onValueChange={setPickerGroupId}
              disabled={attachMutation.isPending}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="Pick a group…" />
              </SelectTrigger>
              <SelectContent>
                {available.map((g) => (
                  <SelectItem key={g.group_id} value={g.group_id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={pickerRole}
              onValueChange={(v) => setPickerRole(v as ProjectRole)}
              disabled={attachMutation.isPending}
            >
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              {/* Full blurbs here — choosing the role for a whole group
                  attachment is a higher-impact decision than a single
                  per-user grant, so users benefit from the extra context. */}
              <SelectContent>
                <ProjectRoleSelectItem role="viewer" />
                <ProjectRoleSelectItem role="editor" />
                <ProjectRoleSelectItem role="manager" />
              </SelectContent>
            </Select>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!pickerGroupId || attachMutation.isPending}
            >
              Attach
            </Button>
          </form>
        ) : null
      }
    >
      {grantsQuery.isLoading && (
        <div className="px-6 py-5">
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {!grantsQuery.isLoading && grants.length === 0 && (
        <div className="px-6 py-5 text-xs text-muted-foreground">
          No groups attached yet.
          {canManage && available.length === 0 && groups.length > 0 && (
            <> All your groups are already attached.</>
          )}
          {canManage && groups.length === 0 && (
            <>
              {' '}Create one on the{' '}
              <a
                href={`/accounts/${accountId}`}
                className="underline hover:text-foreground"
              >
                account page
              </a>
              .
            </>
          )}
        </div>
      )}

      {!grantsQuery.isLoading && grants.length > 0 && (
        <List>
          {grants.map((g: ProjectGroupGrant) => {
            const busy = pendingGroupIds.has(g.group_id);
            return (
              <ListRow
                key={g.group_id}
                leading={
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
                    <Users className="h-4 w-4 text-muted-foreground" />
                  </span>
                }
                title={g.group_name}
                subtitle={
                  <InlineMeta>
                    <span>Attached {formatDate(g.created_at)}</span>
                    {typeof g.member_count === 'number' && (
                      <span>
                        {g.member_count}{' '}
                        {g.member_count === 1 ? 'member' : 'members'}
                      </span>
                    )}
                    {typeof g.override_count === 'number' &&
                      g.override_count > 0 && (
                        <span
                          className="text-amber-700 dark:text-amber-400"
                          title="Account owners and admins always have Manager access on every project, regardless of this grant's role."
                        >
                          {g.override_count} of {g.member_count} get Manager via
                          account role
                        </span>
                      )}
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : canManage ? (
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={g.role}
                        onValueChange={(v) =>
                          updateMutation.mutate({ groupId: g.group_id, role: v as ProjectRole })
                        }
                      >
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <ProjectRoleSelectItem role="viewer" />
                          <ProjectRoleSelectItem role="editor" />
                          <ProjectRoleSelectItem role="manager" />
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetachTarget(g)}
                      >
                        Detach
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.role}
                    </Badge>
                  )
                }
              />
            );
          })}
        </List>
      )}
    </SectionCard>

    <ConfirmDialog
      open={detachTarget !== null}
      onOpenChange={(open) => {
        if (!open) setDetachTarget(null);
      }}
      title="Detach group from project?"
      description={
        detachTarget ? (
          <span>
            <strong>{detachTarget.group_name}</strong> will no longer be
            attached to this project. Members of this group will lose
            their inherited <strong>{detachTarget.role}</strong> access
            (unless they also have a direct grant or belong to another
            attached group). Owners and admins keep their implicit
            Manager access either way.
          </span>
        ) : null
      }
      confirmLabel="Detach group"
      confirmVariant="destructive"
      isPending={detachMutation.isPending}
      onConfirm={() => {
        if (!detachTarget) return;
        const target = detachTarget;
        setDetachTarget(null);
        detachMutation.mutate(target.group_id);
      }}
    />
    </>
  );
}
