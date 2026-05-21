'use client';

import { FormEvent, use, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Shield, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';

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
  type ProjectAccessMember,
  type ProjectRole,
} from '@/lib/projects-client';

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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Members</h1>
      </div>
      <ProjectMembersBody projectId={projectId} />
    </div>
  );
}

function ProjectMembersBody({ projectId }: { projectId: string }) {
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
          <h2 className="text-base font-semibold text-foreground">Project members</h2>
          <p className="text-xs text-muted-foreground">
            Control who can access this project. Account owners and admins always
            have manager access. Invite teammates by email or change their role below.
          </p>
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
      </div>
    </div>
  );
}

function InviteMemberCard({ projectId }: { projectId: string }) {
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
      title="Invite by email"
      description="Add an existing Kortix user to this project."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
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
      title="Project access"
      description="Account owners and admins always have manager access."
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
                        <SelectItem value="none">No access</SelectItem>
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
