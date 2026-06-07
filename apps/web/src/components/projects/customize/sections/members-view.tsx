'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Mail, RefreshCw, Shield, UserPlus, Users, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineMeta } from '@/components/ui/inline-meta';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getProject,
  inviteProjectMember,
  isInviteSent,
  listPendingProjectInvites,
  listProjectAccess,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  attachGroupToProject,
  detachGroupFromProject,
  listProjectGroupGrants,
  updateProjectGroupGrant,
  type InviteProjectMemberResult,
  type ProjectAccessMember,
  type ProjectGroupGrant,
  type ProjectRole,
} from '@/lib/projects-client';
import { sortByRoleThenLabel } from './member-sort';
import { listGroups, removeGroupMember, type AccountGroup } from '@/lib/iam-client';
import {
  inheritedFromGroupSummary,
  isInheritedFromGroupOnly,
} from '@/components/iam/iam-display-helpers';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';

function userLabel(member: Pick<ProjectAccessMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

function copyInviteLink(url: string) {
  navigator.clipboard
    .writeText(url)
    .then(() => toast.success('Invite link copied'))
    .catch(() => toast.error('Could not copy link'));
}

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
          accountId={project?.account_id ?? null}
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
  const [emails, setEmails] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const inviteMutation = useMutation({
    mutationFn: async (list: string[]) =>
      Promise.all(
        list.map(async (addr) => {
          try {
            const res = await inviteProjectMember(projectId, addr, role);
            return { email: addr, ok: true as const, res };
          } catch (err) {
            return {
              email: addr,
              ok: false as const,
              message: (err as Error).message,
            };
          }
        }),
      ),
    onSuccess: (results) => {
      type Ok = { email: string; ok: true; res: InviteProjectMemberResult };
      type Failed = { email: string; ok: false; message: string };
      const succeeded = results.filter((r): r is Ok => r.ok);
      const failed = results.filter((r): r is Failed => !r.ok);
      // Split by which of the two backend shapes came back: an existing
      // Kortix user is granted the role immediately (ProjectAccessMember),
      // a new email gets an org-level invitation carrying the project grant
      // and won't appear in the access list until they accept.
      const invited = succeeded.filter((r) => isInviteSent(r.res));
      const added = succeeded.filter((r) => !isInviteSent(r.res));
      const skipped = succeeded.filter(
        (r) => isInviteSent(r.res) && !r.res.email_sent,
      );

      if (succeeded.length === 1) {
        const r = succeeded[0];
        if (isInviteSent(r.res)) {
          if (r.res.email_sent) {
            toast.success(
              `Invitation sent to ${r.res.email}. They'll land on this project as ${r.res.project_role} when they sign up.`,
            );
          } else {
            // Email delivery was skipped (e.g. Mailtrap not configured) or
            // failed. Surface the link so the inviter can share it manually.
            const inviteUrl = r.res.invite_url;
            toast.warning(
              `Invitation created for ${r.res.email} — email skipped. Share the invite link manually.`,
              {
                action: { label: 'Copy link', onClick: () => copyInviteLink(inviteUrl) },
                duration: 10_000,
              },
            );
          }
        } else {
          toast.success('Member added');
        }
      } else if (succeeded.length > 1) {
        toast.success(`Invited ${succeeded.length} people`);
        if (skipped.length > 0) {
          toast.warning(
            `${skipped.length} ${skipped.length === 1 ? 'email was' : 'emails were'} skipped — share their links manually.`,
          );
        }
      }

      if (failed.length > 0) {
        toast.error(
          failed.length === 1
            ? failed[0].message || 'Failed to invite member'
            : `Failed to invite ${failed.length}: ${failed.map((f) => f.email).join(', ')}`,
        );
      }

      // Make new pending rows visible immediately — without this the page
      // looked unchanged after invite, which was the exact confusion that
      // prompted this card to exist.
      if (invited.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['project-pending-invites', projectId] });
      }
      if (added.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }

      // Keep only the genuinely-failed emails so the admin can retry them.
      setEmails(failed.map((f) => f.email));
      setInputValue('');
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to invite member'),
  });

  /**
   * Parse free text (typed or pasted) into email chips. Splits on commas,
   * semicolons, and whitespace. Returns true if everything parsed cleanly;
   * leaves any invalid tokens in the input and surfaces an error otherwise.
   */
  function commitInput(raw: string): boolean {
    const tokens = raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      setInputValue('');
      return true;
    }
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const t of tokens) {
      if (!EMAIL_RE.test(t)) invalid.push(t);
      else valid.push(t);
    }
    if (valid.length > 0) {
      setEmails((prev) => [...prev, ...valid.filter((v) => !prev.includes(v))]);
    }
    if (invalid.length > 0) {
      setInputValue(invalid.join(', '));
      setInlineError(
        `${invalid.length === 1 ? 'Not a valid email' : 'Not valid emails'}: ${invalid.join(', ')}`,
      );
      return false;
    }
    setInputValue('');
    setInlineError(null);
    return true;
  }

  function removeEmail(addr: string) {
    setEmails((prev) => prev.filter((e) => e !== addr));
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === 'Enter' ||
      event.key === ',' ||
      event.key === ';' ||
      (event.key === ' ' && inputValue.trim() !== '')
    ) {
      event.preventDefault();
      commitInput(inputValue);
    } else if (
      event.key === 'Backspace' &&
      inputValue === '' &&
      emails.length > 0
    ) {
      setEmails((prev) => prev.slice(0, -1));
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    // Only intercept multi-email pastes; let a single address paste normally
    // so the admin can still edit it before committing.
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault();
      commitInput(`${inputValue} ${text}`);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteMutation.isPending) return;
    setInlineError(null);
    const tokens = inputValue
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const invalid = tokens.filter((t) => !EMAIL_RE.test(t));
    if (invalid.length > 0) {
      setInlineError(
        `${invalid.length === 1 ? 'Not a valid email' : 'Not valid emails'}: ${invalid.join(', ')}`,
      );
      return;
    }
    const all = Array.from(new Set([...emails, ...tokens]));
    if (all.length === 0) {
      setInlineError('Add at least one email');
      return;
    }
    setEmails(all);
    setInputValue('');
    inviteMutation.mutate(all);
  }

  const pendingCount = emails.length + (inputValue.trim() ? 1 : 0);

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
        <Label htmlFor="invite-email" className="sm:col-start-1">Emails</Label>
        <Label htmlFor="invite-role" className="hidden sm:block sm:col-start-2">
          Role
        </Label>
        {/* No label above the button — invisible placeholder keeps the
            grid row's intrinsic height stable without rendering text. */}
        <span aria-hidden className="hidden sm:block sm:col-start-3">&nbsp;</span>

        {/* Multi-email chip field — mirrors the Input treatment (rounded-2xl
            border, bg-card, accent focus ring) so it reads as one of the
            shared form controls, just one that holds many addresses. */}
        <div
          className="flex w-full flex-wrap items-center gap-1.5 rounded-2xl border bg-card px-3 py-1.5 text-sm transition-[color] focus-within:outline-none focus-within:ring-2 focus-within:ring-primary/50 sm:col-start-1"
          style={{ minHeight: 44 }}
          onClick={() => inputRef.current?.focus()}
        >
          <Mail className="pointer-events-none h-4 w-4 shrink-0 text-muted-foreground" />
          {emails.map((addr) => (
            <Badge key={addr} variant="secondary" className="gap-1 pr-1">
              {addr}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeEmail(addr);
                }}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Remove ${addr}`}
                disabled={inviteMutation.isPending}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <input
            ref={inputRef}
            id="invite-email"
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (inlineError) setInlineError(null);
            }}
            onKeyDown={handleInputKeyDown}
            onPaste={handlePaste}
            placeholder={
              emails.length === 0
                ? tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line151JsxAttrPlaceholderTeammateExampleCom')
                : 'Add another…'
            }
            autoComplete="off"
            className="min-w-[8rem] flex-1 bg-transparent font-medium outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={inviteMutation.isPending}
          />
        </div>

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
          disabled={pendingCount === 0 || inviteMutation.isPending}
          className="shrink-0 gap-1.5 sm:col-start-3"
          style={{ height: 44 }}
        >
          {inviteMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          {pendingCount > 1 ? `Invite ${pendingCount}` : 'Invite'}
        </Button>
      </form>

      {inlineError ? (
        <p className="mt-2 text-xs text-destructive">{inlineError}</p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Add several at once — separate with commas, spaces, or Enter.
        </p>
      )}
    </SectionCard>
  );
}

function ProjectAccessCard({
  projectId,
  accountId,
  canManage,
  members,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  projectId: string;
  accountId: string | null;
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

  // Group-derived access can't be revoked per-person from a project row (the
  // grant lives on a group). This holds the scoped action chosen from the
  // "Manage access" menu until the user confirms — each action spells out its
  // blast radius (detach = project-scoped; remove-from-group = account-wide).
  type GroupSource = NonNullable<ProjectAccessMember['group_sources']>[number];
  type GroupAction = {
    type: 'detach' | 'removeFromGroup';
    member: ProjectAccessMember;
    group: GroupSource;
  };
  const [groupAction, setGroupAction] = useState<GroupAction | null>(null);

  // Only list people who actually have access — implicit owners/admins, a
  // direct grant, or a group-inherited role. Account members with no access at
  // all aren't shown here (granting them happens via the invite box, which
  // grants existing members instantly). This is what makes Revoke feel right:
  // removing a grant drops the row instead of leaving a lingering "No access".
  const accessMembers = useMemo(
    () =>
      members.filter(
        (m) => m.has_implicit_access || m.effective_project_role != null,
      ),
    [members],
  );
  const sortedMembers = useMemo(
    () => sortByRoleThenLabel(accessMembers, userLabel),
    [accessMembers],
  );

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

  // Project-scoped: removes the group's grant here. Everyone who had access via
  // this group on this project loses it; their other access paths are untouched.
  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onSuccess: () => {
      toast.success('Group detached from project');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to detach group'),
  });

  // Account-scoped: removes the user from the group entirely, so it affects
  // every project that group can access — not just this one.
  const removeFromGroupMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      removeGroupMember(accountId ?? '', groupId, userId),
    onSuccess: () => {
      toast.success('Removed from group');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove from group'),
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
      count={accessMembers.length}
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
                badges={
                  <div className="flex flex-wrap items-center gap-1.5">
                    <AccountRoleBadge role={member.account_role} />
                    {/* Group indicator: which of THIS project's attached groups
                        the member belongs to. Makes group-derived access (and
                        why it isn't directly revocable here) obvious — the
                        access is managed in the Group access section below. */}
                    {(member.group_sources ?? []).map((g) => (
                      <Badge
                        key={g.group_id}
                        variant="outline"
                        size="sm"
                        className="gap-1 font-normal"
                        title={`In the "${g.group_name}" group — manage in Group access`}
                      >
                        <Users className="h-3 w-3" />
                        {g.group_name}
                      </Badge>
                    ))}
                  </div>
                }
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
                    // Access comes from a group, so there's no per-person grant
                    // to revoke on this row. The chip shows the effective role;
                    // the "Manage access" menu exposes the real levers, each
                    // labelled with its blast radius.
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" size="sm" className="capitalize">
                        <Shield className="mr-1 h-3.5 w-3.5" />
                        {member.effective_project_role}
                      </Badge>
                      {canManage && (member.group_sources ?? []).length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="gap-1.5">
                              Manage access
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-80">
                            {(member.group_sources ?? []).flatMap((g) => {
                              const items = [
                                <DropdownMenuItem
                                  key={`${g.group_id}-detach`}
                                  onSelect={() =>
                                    setGroupAction({ type: 'detach', member, group: g })
                                  }
                                  className="flex-col items-start gap-0.5"
                                >
                                  <span>Detach "{g.group_name}" from this project</span>
                                  <span className="text-xs text-muted-foreground">
                                    Removes access for everyone in this group, here only
                                  </span>
                                </DropdownMenuItem>,
                              ];
                              if (accountId) {
                                items.push(
                                  <DropdownMenuItem
                                    key={`${g.group_id}-remove`}
                                    onSelect={() =>
                                      setGroupAction({
                                        type: 'removeFromGroup',
                                        member,
                                        group: g,
                                      })
                                    }
                                    className="flex-col items-start gap-0.5"
                                  >
                                    <span>Remove from "{g.group_name}" group</span>
                                    <span className="text-xs text-muted-foreground">
                                      Affects every project this group can access
                                    </span>
                                  </DropdownMenuItem>,
                                );
                              }
                              return items;
                            })}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Select
                        value={value}
                        onValueChange={(next) => setRole(member, next)}
                        disabled={!canManage}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <ProjectRoleSelectItem role="viewer" />
                          <ProjectRoleSelectItem role="editor" />
                          <ProjectRoleSelectItem role="manager" />
                        </SelectContent>
                      </Select>
                      {canManage && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRevokeTarget(member)}
                          title="Remove this person's access to the project"
                          className="gap-1.5"
                        >
                          <X className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      )}
                    </div>
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

    <ConfirmDialog
      open={groupAction !== null}
      onOpenChange={(open) => {
        if (!open) setGroupAction(null);
      }}
      title={
        groupAction?.type === 'detach'
          ? 'Detach group from project?'
          : 'Remove from group?'
      }
      description={
        groupAction ? (
          groupAction.type === 'detach' ? (
            <span>
              <strong>{groupAction.group.group_name}</strong> will be detached
              from this project. Everyone whose access here comes from this
              group — including <strong>{userLabel(groupAction.member)}</strong>{' '}
              — loses it. Anyone with a direct grant or another attached group
              keeps their access.
            </span>
          ) : (
            <span>
              <strong>{userLabel(groupAction.member)}</strong> will be removed
              from the <strong>{groupAction.group.group_name}</strong> group
              across the whole account — this affects{' '}
              <strong>every project</strong> that group can access, not just
              this one.
            </span>
          )
        ) : null
      }
      confirmLabel={
        groupAction?.type === 'detach' ? 'Detach group' : 'Remove from group'
      }
      confirmVariant="destructive"
      isPending={detachMutation.isPending || removeFromGroupMutation.isPending}
      onConfirm={() => {
        if (!groupAction) return;
        const action = groupAction;
        setGroupAction(null);
        if (action.type === 'detach') {
          detachMutation.mutate(action.group.group_id);
        } else {
          removeFromGroupMutation.mutate({
            groupId: action.group.group_id,
            userId: action.member.user_id,
          });
        }
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
    // Shorter staleTime than the other cards (5s vs 20s) because the
    // invite_expired flag flips with wall-clock time, not user action —
    // a row sitting in this list will silently transition from "Link
    // expires Tue" to "Invite link expired" without any mutation we
    // could invalidate on. Refetching every 5s keeps that hint honest
    // for an admin actively watching the page.
    staleTime: 5_000,
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

  const resendMutation = useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markPending(inviteId),
    onSettled: (_data, _error, inviteId) => clearPending(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        toast.success('Invite email sent');
      } else {
        // Mailtrap not configured (or delivery failed) — hand the admin the
        // link so they can share it manually.
        toast.warning('Email skipped — copy the invite link to share manually', {
          action: { label: 'Copy link', onClick: () => copyInviteLink(result.invite_url) },
          duration: 8_000,
        });
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to resend invitation'),
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
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => resendMutation.mutate(invite.invite_id)}
                        title="Resend the invitation email and extend the link"
                        className="gap-1.5"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Resend
                      </Button>
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
                    </div>
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
            the whole invitation is removed and you'd need to invite them
            again to restore it.
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

  // Defensive client-side sort. The API already sets ORDER BY, but
  // belt-and-braces here so a future API tweak (e.g. switching to a
  // join that loses the ORDER BY) can't cause rows to visibly swap
  // places after a role update. Oldest attachment first matches what
  // the "Attached <date>" subtitle implies.
  const grants = useMemo(() => {
    const raw = grantsQuery.data?.grants ?? [];
    return [...raw].sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at);
      return t !== 0 ? t : a.group_id.localeCompare(b.group_id);
    });
  }, [grantsQuery.data]);
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
