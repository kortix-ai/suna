'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, use, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Shield, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  listProjectAccess,
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

const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  manager: 'Manager',
  editor: 'Editor',
  viewer: 'Viewer',
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
        <header className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line92JsxTextProjectMembers')}</h2>
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line94JsxTextControlWhoCanAccessThisProjectAccountOwners')}</p>
        </header>

        {canManage && <InviteMemberCard projectId={projectId} />}

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
    onSuccess: () => {
      toast.success('Member invited');
      setEmail('');
      queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
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
      description={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line141JsxAttrDescriptionAddAnExistingKortixUserToThisProject')}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={tHardcodedUi.raw('appProjectsIdCustomizeMembersPage.line151JsxAttrPlaceholderTeammateExampleCom')}
            disabled={inviteMutation.isPending}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <Select
            value={role}
            onValueChange={(next) => setRole(next as ProjectRole)}
            disabled={inviteMutation.isPending}
          >
            <SelectTrigger id="invite-role" className="h-9 w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">{PROJECT_ROLE_LABEL.viewer}</SelectItem>
              <SelectItem value="editor">{PROJECT_ROLE_LABEL.editor}</SelectItem>
              <SelectItem value="manager">{PROJECT_ROLE_LABEL.manager}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="submit"
          disabled={!email.trim() || inviteMutation.isPending}
          className="shrink-0 gap-1.5"
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
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

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
    onMutate: ({ userId }) => setPendingUserId(userId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success('Access updated');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to update access'),
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => setPendingUserId(userId),
    onSettled: () => setPendingUserId(null),
    onSuccess: () => {
      toast.success('Access revoked');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to revoke access'),
  });

  function setRole(member: ProjectAccessMember, value: string) {
    if (member.has_implicit_access || !canManage) return;
    if (value === 'none') {
      revokeMutation.mutate(member.user_id);
      return;
    }
    updateMutation.mutate({ userId: member.user_id, role: value as ProjectRole });
  }

  return (
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
            const busy = pendingUserId === member.user_id;
            const value = member.project_role ?? (member.has_implicit_access ? 'manager' : 'none');
            // Group-derived access — at least one project_group_grants
            // row attaches a group this user belongs to. When this is the
            // ONLY access path (no direct grant), the dropdown will say
            // "No access" but the user actually has the group role; the
            // subtitle below makes that explicit and the badge in the
            // trailing slot mirrors the effective role.
            const groupSources = member.group_sources ?? [];
            const inheritedFromGroup =
              !member.has_implicit_access &&
              !member.project_role &&
              member.effective_project_role !== null &&
              groupSources.length > 0;
            const inheritedSummary = inheritedFromGroup
              ? `Inherited ${PROJECT_ROLE_LABEL[member.effective_project_role!]} via ${
                  groupSources[0].group_name
                }${groupSources.length > 1 ? ` + ${groupSources.length - 1} more` : ''}`
              : null;

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
                          <SelectTrigger className="h-8 w-32 text-xs">
                            <SelectValue placeholder="Grant…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No direct grant</SelectItem>
                            <SelectItem value="viewer">{PROJECT_ROLE_LABEL.viewer}</SelectItem>
                            <SelectItem value="editor">{PROJECT_ROLE_LABEL.editor}</SelectItem>
                            <SelectItem value="manager">{PROJECT_ROLE_LABEL.manager}</SelectItem>
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
                        <SelectItem value="viewer">{PROJECT_ROLE_LABEL.viewer}</SelectItem>
                        <SelectItem value="editor">{PROJECT_ROLE_LABEL.editor}</SelectItem>
                        <SelectItem value="manager">{PROJECT_ROLE_LABEL.manager}</SelectItem>
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
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
  }

  const attachMutation = useMutation({
    mutationFn: () => attachGroupToProject(projectId, pickerGroupId, pickerRole),
    onMutate: () => setPendingGroupId(pickerGroupId),
    onSettled: () => setPendingGroupId(null),
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
    onMutate: (input) => setPendingGroupId(input.groupId),
    onSettled: () => setPendingGroupId(null),
    onSuccess: () => {
      toast.success('Role updated');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update role'),
  });

  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (groupId) => setPendingGroupId(groupId),
    onSettled: () => setPendingGroupId(null),
    onSuccess: () => {
      toast.success('Group detached');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to detach group'),
  });

  return (
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
              <SelectContent>
                <SelectItem value="viewer">{PROJECT_ROLE_LABEL.viewer}</SelectItem>
                <SelectItem value="editor">{PROJECT_ROLE_LABEL.editor}</SelectItem>
                <SelectItem value="manager">{PROJECT_ROLE_LABEL.manager}</SelectItem>
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
            const busy = pendingGroupId === g.group_id;
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
                          <SelectItem value="viewer">{PROJECT_ROLE_LABEL.viewer}</SelectItem>
                          <SelectItem value="editor">{PROJECT_ROLE_LABEL.editor}</SelectItem>
                          <SelectItem value="manager">{PROJECT_ROLE_LABEL.manager}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => detachMutation.mutate(g.group_id)}
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
  );
}
