'use client';

import { useTranslations } from 'next-intl';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Clock, KeyRound, Loader2, Mail, MessageSquare, Plus, RefreshCw, Shield, Sparkles, User, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FormEvent, useEffect, useMemo, useState } from 'react';

import {
  inheritedFromGroupSummary,
  isInheritedFromGroupOnly,
} from '@/components/iam/iam-display-helpers';
import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InlineMeta } from '@/components/ui/inline-meta';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { List, ListRow } from '@/components/ui/list';
import Loading from '@/components/ui/loading';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useCopy } from '@/hooks/use-copy';
import {
  listGroups,
  removeGroupMember,
  listPolicies,
  createPolicy,
  deletePolicy,
  listRoles,
  listAgentIdentities,
  type AccountGroup,
  type IamPolicy,
  type PrincipalType,
} from '@/lib/iam-client';
import {
  approveProjectAccessRequest,
  attachGroupToProject,
  detachGroupFromProject,
  getProject,
  inviteProjectMember,
  isInviteSent,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectGroupGrants,
  listProjectResourceGrants,
  createProjectResourceGrant,
  deleteProjectResourceGrant,
  rejectProjectAccessRequest,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  updateProjectGroupGrant,
  type InviteProjectMemberResult,
  type ProjectAccessMember,
  type ProjectGroupGrant,
  type ProjectResourceGrant,
  type ProjectRole,
  type ResourceGrantType,
} from '@kortix/sdk/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';
import { UsersSolid } from '@mynaui/icons-react';
import CustomizeSectionWrapper from '../component/section-wrapper';
import { sortByRoleThenLabel } from '../member-sort';

const MEMBER_ROW = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

function userLabel(member: Pick<ProjectAccessMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function MembersView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Deep-link target tab (e.g. the palette's "Invite members" opens here). Plain
  // in-view tab clicks stay local; this only follows an external openCustomize.
  const requestedTab = useCustomizeStore((s) => s.membersTab);
  const [tab, setTab] = useState<'people' | 'invite'>(() => requestedTab);

  useEffect(() => {
    setTab(requestedTab);
  }, [requestedTab]);

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

  const pendingInvitesQuery = useQuery({
    queryKey: ['project-pending-invites', projectId],
    queryFn: () => listPendingProjectInvites(projectId),
    staleTime: 5_000,
    enabled: !!canManage,
  });

  const accessRequestsQuery = useQuery({
    queryKey: ['project-access-requests', projectId],
    queryFn: () => listProjectAccessRequests(projectId),
    staleTime: 10_000,
    enabled: !!canManage,
  });

  const pendingInviteCount = pendingInvitesQuery.data?.pending?.length ?? 0;
  const pendingRequestCount = accessRequestsQuery.data?.requests?.length ?? 0;
  const inviteTabBadgeCount = pendingInviteCount + pendingRequestCount;

  const peopleContent = (
    <div className="space-y-6">
      <ProjectAccessCard
        projectId={projectId}
        accountId={project?.account_id ?? null}
        canManage={!!canManage}
        members={accessQuery.data?.members ?? []}
        isLoading={accessQuery.isLoading}
        isError={accessQuery.isError}
        error={accessQuery.error as Error | null}
        onRetry={() => accessQuery.refetch()}
        setTab={setTab}
      />

      {project?.account_id && (
        <ProjectGroupGrantsCard
          projectId={projectId}
          accountId={project.account_id}
          canManage={!!canManage}
        />
      )}

      {project?.account_id && (
        <ResourceAccessCard
          projectId={projectId}
          accountId={project.account_id}
          canManage={!!canManage}
          members={accessQuery.data?.members ?? []}
        />
      )}

      {project?.account_id && (
        <ProjectRoleAssignmentsCard
          projectId={projectId}
          accountId={project.account_id}
          canManage={!!canManage}
          members={accessQuery.data?.members ?? []}
        />
      )}
    </div>
  );

  return (
    <CustomizeSectionWrapper
      title={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line92JsxTextProjectMembers')}
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeMembersPage.line94JsxTextControlWhoCanAccessThisProjectAccountOwners',
      )}
      action={
        <PermissionsHelpPopover
          triggerLabel={tHardcodedUi.raw(
            'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTriggerLabelRole9a6a4fdc',
          )}
          align="end"
        />
      }
    >
      {canManage ? (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'people' | 'invite')}
          className="space-y-6"
        >
          <TabsList type="underline" className="flex w-full items-center justify-start">
            <TabsTrigger value="people" className="w-fit flex-none">
              People
            </TabsTrigger>
            <TabsTrigger value="invite" className="w-fit flex-none gap-2">
              Invite
              {inviteTabBadgeCount > 0 ? (
                <Badge variant="secondary" size="sm">
                  {inviteTabBadgeCount}
                </Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="people" className="space-y-6">
            {peopleContent}
          </TabsContent>

          <TabsContent value="invite" className="space-y-6">
            <InviteMemberCard projectId={projectId} />
            <PendingAccessRequestsCard projectId={projectId} />
            <PendingInvitesCard projectId={projectId} />
          </TabsContent>
        </Tabs>
      ) : (
        peopleContent
      )}
    </CustomizeSectionWrapper>
  );
}

function InviteMemberCard({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [inlineError, setInlineError] = useState<string | null>(null);

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
      const invited = succeeded.filter((r) => isInviteSent(r.res));
      const added = succeeded.filter((r) => !isInviteSent(r.res));
      const skipped = succeeded.filter((r) => isInviteSent(r.res) && !r.res.email_sent);

      if (succeeded.length === 1) {
        const r = succeeded[0];
        if (isInviteSent(r.res)) {
          if (r.res.email_sent) {
            successToast(
              `Invitation sent to ${r.res.email}. They'll land on this project as ${r.res.project_role} when they sign up.`,
            );
          } else {
            const inviteUrl = r.res.invite_url;
            warningToast(
              `Invitation created for ${r.res.email} — email skipped. Share the invite link manually.`,
              {
                duration: 10_000,
                button: (
                  <Button size="sm" onClick={() => copy(inviteUrl)}>
                    Copy link
                  </Button>
                ),
              },
            );
          }
        } else {
          successToast('Member added');
        }
      } else if (succeeded.length > 1) {
        successToast(`Invited ${succeeded.length} people`);
        if (skipped.length > 0) {
          warningToast(
            `${skipped.length} ${skipped.length === 1 ? 'email was' : 'emails were'} skipped — share their links manually.`,
          );
        }
      }

      if (failed.length > 0) {
        errorToast(
          failed.length === 1
            ? failed[0].message || 'Failed to invite member'
            : `Failed to invite ${failed.length}: ${failed.map((f) => f.email).join(', ')}`,
        );
      }

      if (invited.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['project-pending-invites', projectId] });
      }
      if (added.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }

      setEmails(failed.map((f) => f.email));
      setInputValue('');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to invite member'),
  });

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
    } else if (event.key === 'Backspace' && inputValue === '' && emails.length > 0) {
      setEmails((prev) => prev.slice(0, -1));
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
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
    <section className="space-y-4">
      <h3 className="text-sm font-medium">
        {tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line140JsxAttrTitleInviteByEmail')}
      </h3>

      <form onSubmit={handleSubmit}>
        <FieldGroup className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end sm:gap-x-3">
            <Field className="gap-1.5 p-0">
              <FieldLabel htmlFor="invite-email">Emails</FieldLabel>
              <InputGroup
                className="border-border bg-popover focus-within:border-kortix-blue flex h-auto min-h-9 flex-wrap items-center gap-1.5 rounded-md border py-0 pr-2 pl-0 transition-[color] focus-within:outline-none"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  e.currentTarget
                    .querySelector<HTMLInputElement>('[data-slot=input-group-control]')
                    ?.focus();
                }}
              >
                <InputGroupAddon align="inline-start" className="pl-3">
                  <Mail />
                </InputGroupAddon>
                {emails.map((addr) => (
                  <Badge key={addr} variant="secondary" size="sm" className="gap-1 pr-1">
                    {addr}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeEmail(addr);
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={`Remove ${addr}`}
                      disabled={inviteMutation.isPending}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <InputGroupInput
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
                      ? tHardcodedUi.raw(
                          'appProjectsIdCustomizeMembersPage.line151JsxAttrPlaceholderTeammateExampleCom',
                        )
                      : 'Add another…'
                  }
                  autoComplete="off"
                  disabled={inviteMutation.isPending}
                  aria-invalid={inlineError ? true : undefined}
                  className="min-w-32 flex-1 px-0 pl-1"
                  variant="popover"
                />
              </InputGroup>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <Select
                value={role}
                onValueChange={(next) => setRole(next as ProjectRole)}
                disabled={inviteMutation.isPending}
              >
                <SelectTrigger id="invite-role" variant="popover">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <ProjectRoleSelectItem role="user" />
                  <ProjectRoleSelectItem role="editor" />
                  <ProjectRoleSelectItem role="manager" />
                </SelectContent>
              </Select>
            </Field>

            <Field className="gap-1.5">
              <Button
                type="submit"
                disabled={pendingCount === 0 || inviteMutation.isPending}
                className="w-full sm:w-auto"
              >
                {inviteMutation.isPending ? <Loading /> : null}
                {pendingCount > 1 ? `Invite ${pendingCount}` : 'Invite'}
              </Button>
            </Field>
          </div>

          {inlineError ? (
            <FieldError className="text-xs">{inlineError}</FieldError>
          ) : (
            <FieldDescription className="text-xs">
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAddSeveralb131056b',
              )}
            </FieldDescription>
          )}
        </FieldGroup>
      </form>
    </section>
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
  setTab,
}: {
  projectId: string;
  accountId: string | null;
  canManage: boolean;
  members: ProjectAccessMember[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  setTab: (tab: 'people' | 'invite') => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());
  const markPending = (userId: string) => setPendingUserIds((prev) => new Set(prev).add(userId));
  const clearPending = (userId: string) =>
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  const [revokeTarget, setRevokeTarget] = useState<ProjectAccessMember | null>(null);

  type GroupSource = NonNullable<ProjectAccessMember['group_sources']>[number];
  type GroupAction = {
    type: 'detach' | 'removeFromGroup';
    member: ProjectAccessMember;
    group: GroupSource;
  };
  const [groupAction, setGroupAction] = useState<GroupAction | null>(null);

  const accessMembers = useMemo(
    () => members.filter((m) => m.has_implicit_access || m.effective_project_role != null),
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
      successToast('Access updated');
      invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update access'),
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => markPending(userId),
    onSettled: (_data, _error, userId) => clearPending(userId),
    onSuccess: () => {
      successToast('Access revoked');
      invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to revoke access'),
  });

  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onSuccess: () => {
      successToast('Group detached from project');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to detach group'),
  });

  const removeFromGroupMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      removeGroupMember(accountId ?? '', groupId, userId),
    onSuccess: () => {
      successToast('Removed from group');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove from group'),
  });

  function setRole(member: ProjectAccessMember, value: string) {
    if (member.has_implicit_access || !canManage) return;
    if (value === 'none') {
      setRevokeTarget(member);
      return;
    }
    updateMutation.mutate({ userId: member.user_id, role: value as ProjectRole });
  }

  return (
    <>
      <section className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-sm font-medium">
              {tHardcodedUi.raw(
                'appProjectsIdCustomizeMembersPage.line260JsxAttrTitleProjectAccess',
              )}
              {accessMembers.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal">
                  ({accessMembers.length})
                </span>
              ) : null}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {tHardcodedUi.raw(
                'appProjectsIdCustomizeMembersPage.line261JsxAttrDescriptionAccountOwnersAndAdminsAlwaysHaveManagerAccess',
              )}
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setTab('invite')}>
            Invite
          </Button>
        </div>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            title="Failed to load members"
            description={error?.message}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        )}

        {!isLoading && !isError && (
          <ul className="space-y-2">
            {sortedMembers.map((member) => {
              const busy = pendingUserIds.has(member.user_id);
              const value =
                member.project_role ?? (member.has_implicit_access ? 'manager' : 'none');
              const inheritedFromGroup = isInheritedFromGroupOnly(member);
              const inheritedSummary = inheritedFromGroupSummary(member);

              return (
                <li key={member.user_id} className={MEMBER_ROW}>
                  <UserAvatar email={member.email ?? ''} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {userLabel(member)}
                      </span>
                      <Badge
                        variant="outline"
                        size="sm"
                        className={
                          member.account_role === 'owner'
                            ? 'border-foreground/30 text-foreground capitalize'
                            : 'capitalize'
                        }
                      >
                        {member.account_role}
                      </Badge>
                      {(member.group_sources ?? []).map((g) => (
                        <Badge
                          key={g.group_id}
                          variant="outline"
                          size="sm"
                          className="gap-1 font-normal"
                          title={`In the "${g.group_name}" group — manage in Group access`}
                        >
                          <Users className="size-3" />
                          {g.group_name}
                        </Badge>
                      ))}
                    </div>
                    <span className="text-muted-foreground text-xs">
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
                    </span>
                  </div>
                  {busy ? (
                    <Loading className="text-muted-foreground shrink-0" />
                  ) : member.has_implicit_access ? (
                    <Badge variant="outline" size="sm">
                      <Shield className="mr-1 size-3.5" />
                      Manager
                    </Badge>
                  ) : inheritedFromGroup ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" size="sm" className="capitalize">
                        <Shield className="mr-1 size-3.5" />
                        {member.effective_project_role}
                      </Badge>
                      {canManage && (member.group_sources ?? []).length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="gap-1.5">
                              {tHardcodedUi.raw(
                                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextManageAccess8bb5d74d',
                              )}
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
                                  <span>
                                    {tHardcodedUi.raw(
                                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextDetachab249756',
                                    )}
                                    {g.group_name}
                                    {tHardcodedUi.raw(
                                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextFromThisaff4c2b1',
                                    )}
                                  </span>
                                  <span className="text-muted-foreground text-xs">
                                    {tHardcodedUi.raw(
                                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextRemovesAccess971d3e55',
                                    )}
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
                                    <span>
                                      {tHardcodedUi.raw(
                                        'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextRemoveFrom9323f47c',
                                      )}
                                      {g.group_name}
                                      {tHardcodedUi.raw(
                                        'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextGroupdb1c1d43',
                                      )}
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                      {tHardcodedUi.raw(
                                        'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAffectsEvery735d8dbc',
                                      )}
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
                    <div className="flex shrink-0 items-center gap-1">
                      <Select
                        value={value}
                        onValueChange={(next) => setRole(member, next)}
                        disabled={!canManage}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <ProjectRoleSelectItem role="user" />
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
                          title={tHardcodedUi.raw(
                            'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleRemovec6407d5f',
                          )}
                          className="gap-1.5"
                        >
                          <X className="size-3.5" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleRevoke0cd09fad',
        )}
        description={
          revokeTarget ? (
            <span>
              <strong>{userLabel(revokeTarget)}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillLoseb378c86b',
              )}
            </span>
          ) : null
        }
        confirmLabel={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrConfirmLabelRevokef1b3384e',
        )}
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (!revokeTarget) return;
          const target = revokeTarget;
          setRevokeTarget(null);
          revokeMutation.mutate(target.user_id);
        }}
      />

      <ConfirmDialog
        open={groupAction !== null}
        onOpenChange={(open) => {
          if (!open) setGroupAction(null);
        }}
        title={groupAction?.type === 'detach' ? 'Detach group from project?' : 'Remove from group?'}
        description={
          groupAction ? (
            groupAction.type === 'detach' ? (
              <span>
                <strong>{groupAction.group.group_name}</strong>{' '}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillBeddf66ee4',
                )}
                <strong>{userLabel(groupAction.member)}</strong>{' '}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextLosesIte94d42a4',
                )}
              </span>
            ) : (
              <span>
                <strong>{userLabel(groupAction.member)}</strong>{' '}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillBe60764226',
                )}
                <strong>{groupAction.group.group_name}</strong>{' '}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextGroupAcrossc2ff897e',
                )}{' '}
                <strong>
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextEveryProjecta802077b',
                  )}
                </strong>{' '}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextThatGroup4e384269',
                )}
              </span>
            )
          ) : null
        }
        confirmLabel={groupAction?.type === 'detach' ? 'Detach group' : 'Remove from group'}
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

function PendingAccessRequestsCard({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const queryKey = ['project-access-requests', projectId];
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const markBusy = (id: string) => setBusyIds((prev) => new Set(prev).add(id));
  const clearBusy = (id: string) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const requestsQuery = useQuery({
    queryKey,
    queryFn: () => listProjectAccessRequests(projectId),
    staleTime: 10_000,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => approveProjectAccessRequest(projectId, requestId, 'user'),
    onMutate: (requestId) => markBusy(requestId),
    onSettled: (_data, _error, requestId) => clearBusy(requestId),
    onSuccess: (result) => {
      successToast(`${result.member.email ?? 'Requester'} can now view this project`);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to approve request'),
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => rejectProjectAccessRequest(projectId, requestId),
    onMutate: (requestId) => markBusy(requestId),
    onSettled: (_data, _error, requestId) => clearBusy(requestId),
    onSuccess: () => {
      successToast('Access request declined');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to decline request'),
  });

  const requests = requestsQuery.data?.requests ?? [];

  if (!requestsQuery.isLoading && requests.length === 0) return null;

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">
          {tHardcodedUi.raw(
            'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleAccess7a756f48',
          )}
          {requests.length > 0 ? (
            <span className="text-muted-foreground ml-1.5 font-normal">({requests.length})</span>
          ) : null}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {tHardcodedUi.raw(
            'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrDescriptionPeopleea85927a',
          )}
        </p>
      </div>

      {requestsQuery.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-md" />
          ))}
        </div>
      )}

      {!requestsQuery.isLoading && requests.length > 0 && (
        <ul className="space-y-2">
          {requests.map((request) => {
            const busy = busyIds.has(request.request_id);
            return (
              <li key={request.request_id} className={MEMBER_ROW}>
                <span className="bg-kortix-yellow/10 text-kortix-yellow inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                  <MessageSquare className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-foreground truncate text-sm font-medium">
                    {request.requester_email}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    <InlineMeta>
                      <span>Requested {formatDate(request.created_at)}</span>
                      {request.message ? <span>"{request.message}"</span> : null}
                    </InlineMeta>
                  </span>
                </div>
                {busy ? (
                  <Loading className="text-muted-foreground shrink-0" />
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => approveMutation.mutate(request.request_id)}
                      className="gap-1.5"
                    >
                      <Check className="size-3.5" />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => rejectMutation.mutate(request.request_id)}
                      className="gap-1.5"
                    >
                      <X className="size-3.5" />
                      Decline
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PendingInvitesCard({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });
  const queryClient = useQueryClient();
  const queryKey = ['project-pending-invites', projectId];
  const [pendingInviteIds, setPendingInviteIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingInviteIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingInviteIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [revokeTarget, setRevokeTarget] = useState<{ inviteId: string; email: string } | null>(
    null,
  );

  const invitesQuery = useQuery({
    queryKey,
    queryFn: () => listPendingProjectInvites(projectId),
    staleTime: 5_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markPending(inviteId),
    onSettled: (_data, _error, inviteId) => clearPending(inviteId),
    onSuccess: (result) => {
      successToast(
        result.invitation_cancelled
          ? 'Invitation cancelled.'
          : 'Project access removed from invitation.',
      );
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to revoke invitation'),
  });

  const resendMutation = useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markPending(inviteId),
    onSettled: (_data, _error, inviteId) => clearPending(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        successToast('Invite email sent');
      } else {
        warningToast('Email skipped — copy the invite link to share manually', {
          duration: 8_000,
          button: (
            <Button size="sm" onClick={() => copy(result.invite_url)}>
              Copy link
            </Button>
          ),
        });
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to resend invitation'),
  });

  const pending = invitesQuery.data?.pending ?? [];

  if (!invitesQuery.isLoading && pending.length === 0) return null;

  return (
    <>
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">
            {tHardcodedUi.raw(
              'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitlePendingbfbe9f8b',
            )}
            {pending.length > 0 ? (
              <span className="text-muted-foreground ml-1.5 font-normal">({pending.length})</span>
            ) : null}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {tHardcodedUi.raw(
              'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrDescriptionPeople552a0c43',
            )}
          </p>
        </div>

        {invitesQuery.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        )}

        {!invitesQuery.isLoading && pending.length > 0 && (
          <ul className="space-y-2">
            {pending.map((invite) => {
              const busy = pendingInviteIds.has(invite.invite_id);
              return (
                <li key={invite.invite_id} className={MEMBER_ROW}>
                  <span className="bg-kortix-orange/10 text-kortix-orange inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                    <Mail className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {invite.email}
                      </span>
                      <Badge variant="outline" size="sm" className="capitalize">
                        {invite.project_role}
                      </Badge>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      <InlineMeta>
                        <span>Invited {formatDate(invite.created_at)}</span>
                        {invite.invited_by_email && <span>by {invite.invited_by_email}</span>}
                        {invite.invite_expired ? (
                          <span className="text-kortix-orange">
                            {tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextInviteLinkef92ef7c',
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="size-3" />
                            {tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextLinkExpires4566b25e',
                            )}
                            {formatDate(invite.invite_expires_at)}
                          </span>
                        )}
                      </InlineMeta>
                    </span>
                  </div>
                  {busy ? (
                    <Loading className="text-muted-foreground shrink-0" />
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => resendMutation.mutate(invite.invite_id)}
                        title={tHardcodedUi.raw(
                          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleResendc80cacee',
                        )}
                        className="gap-1.5"
                      >
                        <RefreshCw className="size-3.5" />
                        Resend
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRevokeTarget({ inviteId: invite.invite_id, email: invite.email })
                        }
                        title={tHardcodedUi.raw(
                          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleCancel670de1c6',
                        )}
                        className="gap-1.5"
                      >
                        <X className="size-3.5" />
                        Revoke
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleRevoke99f32c76',
        )}
        description={
          revokeTarget ? (
            <span>
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextTheInvitation06f8c62e',
              )}
              <strong>{revokeTarget.email}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillBe5ec1d9e8',
              )}
            </span>
          ) : null
        }
        confirmLabel={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrConfirmLabelRevoke3c3ea8b9',
        )}
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

function ProjectGroupGrantsCard({
  projectId,
  accountId,
  canManage,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const grants = useMemo(() => {
    const raw = grantsQuery.data?.grants ?? [];
    return [...raw].sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at);
      return t !== 0 ? t : a.group_id.localeCompare(b.group_id);
    });
  }, [grantsQuery.data]);
  const groups: AccountGroup[] = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const attachedIds = useMemo(() => new Set(grants.map((g) => g.group_id)), [grants]);
  const available = useMemo(
    () => groups.filter((g) => !attachedIds.has(g.group_id)),
    [groups, attachedIds],
  );

  const [pickerGroupId, setPickerGroupId] = useState<string>('');
  const [pickerRole, setPickerRole] = useState<ProjectRole>('editor');
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingGroupIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingGroupIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [detachTarget, setDetachTarget] = useState<ProjectGroupGrant | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  }

  const attachMutation = useMutation({
    mutationFn: () => attachGroupToProject(projectId, pickerGroupId, pickerRole),
    onMutate: () => {
      markPending(pickerGroupId);
      return { groupId: pickerGroupId };
    },
    onSettled: (_data, _error, _vars, ctx) => clearPending(ctx!.groupId),
    onSuccess: () => {
      successToast('Group attached');
      setPickerGroupId('');
      setPickerRole('editor');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to attach group'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { groupId: string; role: ProjectRole }) =>
      updateProjectGroupGrant(projectId, input.groupId, input.role),
    onMutate: (input) => markPending(input.groupId),
    onSettled: (_data, _error, input) => clearPending(input.groupId),
    onSuccess: () => {
      successToast('Role updated');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update role'),
  });

  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (groupId) => markPending(groupId),
    onSettled: (_data, _error, groupId) => clearPending(groupId),
    onSuccess: () => {
      successToast('Group detached');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to detach group'),
  });

  return (
    <>
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleGroupfbf9c01c',
              )}
              {grants.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal">({grants.length})</span>
              ) : null}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrDescriptionAttach372d6d3a',
              )}
            </p>
          </div>

          {canManage && available.length > 0 ? (
            <form
              className="flex shrink-0 items-center gap-1.5"
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
                  <SelectValue
                    placeholder={tHardcodedUi.raw(
                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrPlaceholderPickf0432525',
                    )}
                  />
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
                <SelectContent>
                  <ProjectRoleSelectItem role="user" />
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
          ) : null}
        </div>

        {grantsQuery.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        )}

        {!grantsQuery.isLoading && grants.length === 0 && (
          <EmptyState
            icon={Users}
            title="No groups attached"
            description={
              canManage && groups.length === 0 ? (
                <>
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextCreateOne549d8748',
                  )}{' '}
                  <a href={`/accounts/${accountId}`} className="hover:text-foreground underline">
                    {tHardcodedUi.raw(
                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAccountPage432b8a72',
                    )}
                  </a>
                  .
                </>
              ) : canManage && available.length === 0 && groups.length > 0 ? (
                tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAllYour31c4dcb5',
                )
              ) : (
                tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextNoGroups09e82ebd',
                )
              )
            }
          />
        )}

        {!grantsQuery.isLoading && grants.length > 0 && (
          <ul className="space-y-2">
            {grants.map((g: ProjectGroupGrant) => {
              const busy = pendingGroupIds.has(g.group_id);
              return (
                <li key={g.group_id} className={MEMBER_ROW}>
                  <EntityAvatar icon={UsersSolid} size="md" />
                  <div className="min-w-0 flex-1">
                    <span className="text-foreground truncate text-sm font-medium">
                      {g.group_name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      <InlineMeta>
                        <span>Attached {formatDate(g.created_at)}</span>
                        {typeof g.member_count === 'number' && (
                          <span>
                            {g.member_count} {g.member_count === 1 ? 'member' : 'members'}
                          </span>
                        )}
                        {typeof g.override_count === 'number' && g.override_count > 0 && (
                          <span
                            className="text-kortix-orange"
                            title={tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleAccount2914778b',
                            )}
                          >
                            {g.override_count} of {g.member_count}{' '}
                            {tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextGetManagera88e6fc4',
                            )}
                          </span>
                        )}
                      </InlineMeta>
                    </span>
                  </div>
                  {busy ? (
                    <Loading className="text-muted-foreground shrink-0" />
                  ) : canManage ? (
                    <div className="flex shrink-0 items-center gap-1.5">
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
                          <ProjectRoleSelectItem role="user" />
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
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={detachTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDetachTarget(null);
        }}
        title={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleDetach8e4cbc87',
        )}
        description={
          detachTarget ? (
            <span>
              <strong>{detachTarget.group_name}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillNob7c4fd05',
              )}
              <strong>{detachTarget.role}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAccessUnless520e90ca',
              )}
            </span>
          ) : null
        }
        confirmLabel={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrConfirmLabelDetache64492d2',
        )}
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

// ─── Per-resource scoping (agents/skills → member/department) ──────────────

/**
 * A row of filter pills shown above a long list (resource grants, role
 * bindings). Each pill carries its own count; the active one is solid. Render
 * only when there's more than one category to switch between — a single-category
 * list needs no filter chrome.
 */
function FilterChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="border-border/60 flex flex-wrap items-center gap-1.5 border-b px-6 py-2.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.value
              ? 'bg-foreground text-background'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted',
          )}
        >
          {o.label}
          <span className={cn('tabular-nums', value === o.value ? 'opacity-70' : 'opacity-50')}>
            {o.count}
          </span>
        </button>
      ))}
    </div>
  );
}

function ResourceAccessCard({
  projectId,
  accountId,
  canManage,
  members,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
  members: ProjectAccessMember[];
}) {
  const queryClient = useQueryClient();
  const grantsKey = ['project-resource-grants', projectId];

  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => listProjectResourceGrants(projectId),
    staleTime: 20_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });

  const resources = grantsQuery.data?.resources ?? { agents: [], skills: [], secrets: [] };
  const grants = useMemo(() => {
    const raw = grantsQuery.data?.grants ?? [];
    return [...raw].sort((a, b) => {
      const t = a.resource_type.localeCompare(b.resource_type);
      if (t !== 0) return t;
      const r = a.resource_id.localeCompare(b.resource_id);
      return r !== 0 ? r : a.principal_label.localeCompare(b.principal_label);
    });
  }, [grantsQuery.data]);
  const groups: AccountGroup[] = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  // Display name for a resource id (falls back to the id itself).
  const resourceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of resources.agents) m.set(`agent:${a.id}`, a.name);
    for (const s of resources.skills) m.set(`skill:${s.id}`, s.name);
    for (const s of resources.secrets ?? []) m.set(`secret:${s.id}`, s.name);
    return m;
  }, [resources]);

  const hasResources =
    resources.agents.length > 0 || resources.skills.length > 0 || (resources.secrets?.length ?? 0) > 0;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerType, setPickerType] = useState<ResourceGrantType | ''>(''); // step 1
  const [pickerResourceId, setPickerResourceId] = useState<string>(''); // step 2
  const [principalValue, setPrincipalValue] = useState<string>(''); // "member:id" | "group:id"
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // Step 1 of the grant flow: pick the resource TYPE. Only offer types that
  // actually have resources, so the type buttons never lead to an empty list.
  const typeOptions = useMemo(
    () =>
      (
        [
          { type: 'agent', label: 'Agent', Icon: Bot, items: resources.agents },
          { type: 'skill', label: 'Skill', Icon: Sparkles, items: resources.skills },
          { type: 'secret', label: 'Secret', Icon: KeyRound, items: resources.secrets ?? [] },
        ] as const
      ).filter((o) => o.items.length > 0),
    [resources],
  );
  // Step 2 options: only the resources of the chosen type.
  const activeItems = typeOptions.find((o) => o.type === pickerType)?.items ?? [];

  function resetGrantForm() {
    setPickerType('');
    setPickerResourceId('');
    setPrincipalValue('');
  }

  function onTypeChange(t: ResourceGrantType) {
    setPickerType(t);
    setPickerResourceId(''); // the previous pick belongs to a different type
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    // The agent/skill lists the rest of the UI renders are now filtered, so the
    // project detail must refetch to reflect what this user can see.
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
  }

  function splitOnce(v: string): [string, string] {
    const i = v.indexOf(':');
    return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const [principalType, principalId] = splitOnce(principalValue);
      return createProjectResourceGrant(projectId, {
        resourceType: pickerType as ResourceGrantType,
        resourceId: pickerResourceId,
        principalType: principalType as 'member' | 'group',
        principalId,
      });
    },
    onSuccess: () => {
      successToast('Resource scoped');
      resetGrantForm();
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to scope resource'),
  });

  function onDialogOpenChange(next: boolean) {
    if (createMutation.isPending) return;
    if (next) {
      // Default the type to the first available so the resource list is live
      // immediately; the user can still switch types from there.
      resetGrantForm();
      setPickerType(typeOptions[0]?.type ?? '');
    }
    setDialogOpen(next);
  }

  const removeMutation = useMutation({
    mutationFn: (grantId: string) => deleteProjectResourceGrant(projectId, grantId),
    onMutate: (grantId) => markPending(grantId),
    onSettled: (_d, _e, grantId) => clearPending(grantId),
    onSuccess: () => {
      successToast('Scope removed');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove scope'),
  });

  // List filter (below): keep a long, mixed grant list scannable by type.
  const [resourceFilter, setResourceFilter] = useState<'all' | ResourceGrantType>('all');
  const grantCounts = useMemo(() => {
    const c: Record<ResourceGrantType, number> = { agent: 0, skill: 0, secret: 0 };
    for (const g of grants) c[g.resource_type] += 1;
    return c;
  }, [grants]);
  const grantFilterOptions = useMemo(() => {
    const opts: { value: 'all' | ResourceGrantType; label: string; count: number }[] = [
      { value: 'all', label: 'All', count: grants.length },
    ];
    if (grantCounts.agent) opts.push({ value: 'agent', label: 'Agents', count: grantCounts.agent });
    if (grantCounts.skill) opts.push({ value: 'skill', label: 'Skills', count: grantCounts.skill });
    if (grantCounts.secret) opts.push({ value: 'secret', label: 'Secrets', count: grantCounts.secret });
    return opts;
  }, [grants.length, grantCounts]);
  const visibleGrants = useMemo(
    () => (resourceFilter === 'all' ? grants : grants.filter((g) => g.resource_type === resourceFilter)),
    [grants, resourceFilter],
  );

  const canSubmit = !!pickerType && !!pickerResourceId && !!principalValue && !createMutation.isPending;

  return (
    <SectionCard
      flush
      title="Resource access"
      description="Scope specific agents, skills & secrets to a member or department. A resource with no grants stays open to everyone with project access; granting one restricts it to just the people or departments you pick."
      count={grants.length}
      action={
        canManage && hasResources ? (
          <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Grant access
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Grant resource access</DialogTitle>
                <DialogDescription>
                  Scope an agent, skill, or secret to a member or department. Ungranted resources stay
                  open to everyone with project access.
                </DialogDescription>
              </DialogHeader>

              <form
                id="grant-resource-form"
                className="space-y-4 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!canSubmit) return;
                  createMutation.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">1. Resource type</span>
                  <div className="flex gap-1.5">
                    {typeOptions.map(({ type, label, Icon }) => (
                      <Button
                        key={type}
                        type="button"
                        size="sm"
                        variant={pickerType === type ? 'default' : 'outline'}
                        className="flex-1 gap-1.5"
                        onClick={() => onTypeChange(type)}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">
                    2. {pickerType ? `${pickerType[0].toUpperCase()}${pickerType.slice(1)}` : 'Resource'}
                  </span>
                  <Select
                    value={pickerResourceId}
                    onValueChange={setPickerResourceId}
                    disabled={!pickerType || createMutation.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={pickerType ? `Select a ${pickerType}` : 'Pick a type first'} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeItems.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">3. Grant to</span>
                  <Select
                    value={principalValue}
                    onValueChange={setPrincipalValue}
                    disabled={createMutation.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Member or department" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={`member:${m.user_id}`} value={`member:${m.user_id}`}>
                          {userLabel(m)}
                        </SelectItem>
                      ))}
                      {groups.map((g) => (
                        <SelectItem key={`group:${g.group_id}`} value={`group:${g.group_id}`}>
                          {g.name} · dept
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </form>

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="ghost" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" form="grant-resource-form" size="sm" disabled={!canSubmit}>
                  {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Grant access'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null
      }
    >
      {grantsQuery.isLoading && (
        <div className="px-6 py-5">
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {!grantsQuery.isLoading && grants.length === 0 && (
        <div className="text-muted-foreground px-6 py-5 text-xs">
          {hasResources
            ? 'Nothing is scoped yet — every member with project access can see and use all agents, skills, and secrets. Grant one above to restrict it to specific people or departments.'
            : 'This project has no agents, skills, or secrets to scope yet. Add some first, then come back here to limit who can use them.'}
        </div>
      )}

      {!grantsQuery.isLoading && grants.length > 0 && (
        <>
          {grantFilterOptions.length > 2 && (
            <FilterChips value={resourceFilter} onChange={setResourceFilter} options={grantFilterOptions} />
          )}
          <List>
            {visibleGrants.map((g: ProjectResourceGrant) => {
              const busy = pendingIds.has(g.grant_id);
              const displayName = resourceName.get(`${g.resource_type}:${g.resource_id}`) ?? g.resource_id;
            const ResourceIcon = g.resource_type === 'agent' ? Bot : g.resource_type === 'secret' ? KeyRound : Sparkles;
            return (
              <ListRow
                key={g.grant_id}
                leading={
                  <span className="bg-muted/60 flex h-8 w-8 items-center justify-center rounded-full">
                    <ResourceIcon className="text-muted-foreground h-4 w-4" />
                  </span>
                }
                title={
                  <span className="flex items-center gap-2">
                    {displayName}
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.resource_type}
                    </Badge>
                    {g.orphaned && (
                      <Badge
                        variant="outline"
                        size="sm"
                        className="border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400"
                        title={`This ${g.resource_type} no longer exists (renamed or deleted). The grant is inert — the restriction has lapsed. Remove it or re-grant the current ${g.resource_type}.`}
                      >
                        renamed / removed
                      </Badge>
                    )}
                  </span>
                }
                subtitle={
                  <InlineMeta>
                    <span>
                      {g.principal_type === 'group' ? 'Dept' : 'Member'}: {g.principal_label}
                    </span>
                    <span>Granted {formatDate(g.created_at)}</span>
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  ) : canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeMutation.mutate(g.grant_id)}
                    >
                      Remove
                    </Button>
                  ) : (
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.principal_type}
                    </Badge>
                  )
                }
              />
            );
          })}
          </List>
        </>
      )}
    </SectionCard>
  );
}

/**
 * Custom-role assignments for THIS project — the project-level view of the
 * account Roles page's bindings. Custom roles are DEFINED on the account Roles
 * page; here a manager grants one (to a member / department / agent) scoped to
 * this project, so a project's full access picture lives in one place.
 */
function ProjectRoleAssignmentsCard({
  projectId,
  accountId,
  canManage,
  members,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
  members: ProjectAccessMember[];
}) {
  const queryClient = useQueryClient();
  const policiesKey = ['project-policies', projectId];

  const policiesQuery = useQuery({
    queryKey: policiesKey,
    queryFn: () => listPolicies(accountId, { scopeId: projectId }),
    staleTime: 20_000,
  });
  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['iam-agent-identities', accountId],
    queryFn: () => listAgentIdentities(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });

  // Only project-scoped bindings for THIS project (account-wide custom roles
  // apply too, but they're managed on the account page, not per-project).
  const policies = useMemo(
    () => (policiesQuery.data ?? []).filter((p) => p.scope_type === 'project' && p.scope_id === projectId),
    [policiesQuery.data, projectId],
  );
  const customRoles = useMemo(() => (rolesQuery.data ?? []).filter((r) => !r.is_system), [rolesQuery.data]);
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const projectAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((a) => a.project_id === projectId),
    [agentsQuery.data, projectId],
  );

  const roleNameById = useMemo(
    () => new Map((rolesQuery.data ?? []).map((r) => [r.role_id, r.name])),
    [rolesQuery.data],
  );
  const memberLabelById = useMemo(() => new Map(members.map((m) => [m.user_id, userLabel(m)])), [members]);
  const groupNameById = useMemo(() => new Map(groups.map((g) => [g.group_id, g.name])), [groups]);
  const agentLabelById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((a) => [a.service_account_id, a.agent_name ?? a.name])),
    [agentsQuery.data],
  );

  function principalLabel(p: IamPolicy): { kind: string; label: string; missing: boolean } {
    if (p.principal_type === 'group') {
      return { kind: 'Dept', label: groupNameById.get(p.principal_id) ?? p.principal_id, missing: false };
    }
    if (p.principal_type === 'token') {
      // Agent SAs resolve from the account-wide identity list; a miss means the
      // agent was deleted/renamed, so the binding is stale. Show a short id and
      // flag it rather than a bare 36-char UUID.
      const name = agentLabelById.get(p.principal_id);
      return { kind: 'Agent', label: name ?? `${p.principal_id.slice(0, 8)}…`, missing: !name };
    }
    return { kind: 'Member', label: memberLabelById.get(p.principal_id) ?? p.principal_id, missing: false };
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [subjectType, setSubjectType] = useState<PrincipalType | ''>(''); // step 1
  const [subjectId, setSubjectId] = useState(''); // step 2
  const [roleId, setRoleId] = useState('');
  const [policyFilter, setPolicyFilter] = useState<'all' | PrincipalType>('all');
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: policiesKey });
  }

  // Step 1 of the assign flow: pick the SUBJECT type. Only offer types that
  // have someone to assign (no empty "Agent" list when the project has none).
  const subjectOptions = useMemo(
    () =>
      (
        [
          { type: 'member', label: 'Member', Icon: User, items: members.map((m) => ({ id: m.user_id, name: userLabel(m) })) },
          { type: 'group', label: 'Dept', Icon: Users, items: groups.map((g) => ({ id: g.group_id, name: g.name })) },
          {
            type: 'token',
            label: 'Agent',
            Icon: Bot,
            items: projectAgents.map((a) => ({ id: a.service_account_id, name: a.agent_name ?? a.name })),
          },
        ] as const
      ).filter((o) => o.items.length > 0),
    [members, groups, projectAgents],
  );
  // Step 2 options: only the subjects of the chosen type.
  const activeSubjects = subjectOptions.find((o) => o.type === subjectType)?.items ?? [];

  function resetAssignForm() {
    setSubjectType('');
    setSubjectId('');
    setRoleId('');
  }
  function onSubjectTypeChange(t: PrincipalType) {
    setSubjectType(t);
    setSubjectId(''); // the previous pick belongs to a different subject type
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createPolicy(accountId, {
        principalType: subjectType as PrincipalType,
        principalId: subjectId,
        scopeType: 'project',
        scopeId: projectId,
        roleId,
      }),
    onSuccess: () => {
      successToast('Role assigned');
      resetAssignForm();
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to assign role'),
  });

  function onDialogOpenChange(next: boolean) {
    if (createMutation.isPending) return;
    if (next) {
      resetAssignForm();
      setSubjectType(subjectOptions[0]?.type ?? '');
    }
    setDialogOpen(next);
  }

  const removeMutation = useMutation({
    mutationFn: (policyId: string) => deletePolicy(accountId, policyId),
    onMutate: (policyId) => markPending(policyId),
    onSettled: (_d, _e, policyId) => clearPending(policyId),
    onSuccess: () => {
      successToast('Assignment removed');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove assignment'),
  });

  // List filter (below): segment a long mixed binding list by subject type.
  const policyCounts = useMemo(() => {
    const c: Record<string, number> = { member: 0, group: 0, token: 0 };
    for (const p of policies) c[p.principal_type] = (c[p.principal_type] ?? 0) + 1;
    return c;
  }, [policies]);
  const policyFilterOptions = useMemo(() => {
    const opts: { value: 'all' | PrincipalType; label: string; count: number }[] = [
      { value: 'all', label: 'All', count: policies.length },
    ];
    if (policyCounts.member) opts.push({ value: 'member', label: 'Members', count: policyCounts.member });
    if (policyCounts.group) opts.push({ value: 'group', label: 'Depts', count: policyCounts.group });
    if (policyCounts.token) opts.push({ value: 'token', label: 'Agents', count: policyCounts.token });
    return opts;
  }, [policies.length, policyCounts]);
  const visiblePolicies = useMemo(
    () => (policyFilter === 'all' ? policies : policies.filter((p) => p.principal_type === policyFilter)),
    [policies, policyFilter],
  );

  const canSubmit = !!subjectType && !!subjectId && !!roleId && !createMutation.isPending;

  return (
    <SectionCard
      flush
      title="Custom roles"
      description="Grant a custom role to a member, department, or agent on this project. Custom roles are defined on the account Roles page; here you bind them for this project only."
      count={policies.length}
      action={
        canManage && customRoles.length > 0 ? (
          <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Assign role
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Assign a custom role</DialogTitle>
                <DialogDescription>
                  Bind a custom role to a member, department, or agent on this project only.
                </DialogDescription>
              </DialogHeader>

              <form
                id="assign-role-form"
                className="space-y-4 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!canSubmit) return;
                  createMutation.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">1. Assign to</span>
                  <div className="flex gap-1.5">
                    {subjectOptions.map(({ type, label, Icon }) => (
                      <Button
                        key={type}
                        type="button"
                        size="sm"
                        variant={subjectType === type ? 'default' : 'outline'}
                        className="flex-1 gap-1.5"
                        onClick={() => onSubjectTypeChange(type)}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">
                    2. {subjectType === 'group' ? 'Department' : subjectType === 'token' ? 'Agent' : 'Member'}
                  </span>
                  <Select
                    value={subjectId}
                    onValueChange={setSubjectId}
                    disabled={!subjectType || createMutation.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={subjectType ? 'Select one' : 'Pick a type first'} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSubjects.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs font-medium">3. Custom role</span>
                  <Select value={roleId} onValueChange={setRoleId} disabled={createMutation.isPending}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {customRoles.map((r) => (
                        <SelectItem key={r.role_id} value={r.role_id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </form>

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="ghost" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" form="assign-role-form" size="sm" disabled={!canSubmit}>
                  {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Assign role'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null
      }
    >
      {policiesQuery.isLoading && (
        <div className="px-6 py-5">
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {!policiesQuery.isLoading && policies.length === 0 && (
        <div className="text-muted-foreground px-6 py-5 text-xs">
          {customRoles.length === 0 ? (
            <>
              No custom roles exist yet. Create one on the{' '}
              <a href={`/accounts/${accountId}?tab=roles`} className="underline">
                account Roles page
              </a>
              , then bind it here for this project.
            </>
          ) : (
            'No custom-role assignments on this project yet. Bind one above to grant a member, department, or agent a custom role here.'
          )}
        </div>
      )}

      {!policiesQuery.isLoading && policies.length > 0 && (
        <>
          {policyFilterOptions.length > 2 && (
            <FilterChips value={policyFilter} onChange={setPolicyFilter} options={policyFilterOptions} />
          )}
          <List>
            {visiblePolicies.map((p) => {
            const busy = pendingIds.has(p.policy_id);
            const { kind, label, missing } = principalLabel(p);
            return (
              <ListRow
                key={p.policy_id}
                leading={
                  <span className="bg-muted/60 flex h-8 w-8 items-center justify-center rounded-full">
                    <Shield className="text-muted-foreground h-4 w-4" />
                  </span>
                }
                title={
                  <span className="flex items-center gap-2">
                    {roleNameById.get(p.role_id) ?? p.role_id}
                    <Badge variant="outline" size="sm">
                      Custom
                    </Badge>
                  </span>
                }
                subtitle={
                  <InlineMeta>
                    <span className="flex items-center gap-1.5">
                      {kind}: {label}
                      {missing && (
                        <Badge
                          variant="outline"
                          size="sm"
                          className="border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400"
                          title="This agent no longer exists (deleted or renamed). The binding is stale — remove it or re-assign the current agent."
                        >
                          removed
                        </Badge>
                      )}
                    </span>
                    {p.expires_at ? <span>Expires {formatDate(p.expires_at)}</span> : null}
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  ) : canManage ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => removeMutation.mutate(p.policy_id)}>
                      Remove
                    </Button>
                  ) : (
                    <Badge variant="outline" size="sm" className="capitalize">
                      {kind}
                    </Badge>
                  )
                }
              />
            );
          })}
          </List>
        </>
      )}
    </SectionCard>
  );
}
