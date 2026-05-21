'use client';

import { FormEvent, use, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Github, Loader2, Settings, Shield, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
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
  archiveProject,
  getProject,
  listProjectAccess,
  revokeProjectAccess,
  updateProject,
  updateProjectAccess,
  type ProjectAccessMember,
  type ProjectRole,
} from '@/lib/projects-client';
import { SandboxSnapshotCard } from '@/components/projects/sandbox-snapshot-card';

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

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <SettingsView projectId={projectId} />;
}

export function SettingsView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Settings className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Settings</h1>
      </div>
      <ProjectSettingsBody projectId={projectId} />
    </div>
  );
}

function ProjectSettingsBody({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);

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

  const archiveMutation = useMutation({
    mutationFn: () => archiveProject(projectId),
    onSuccess: () => {
      toast.success('Project archived');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setArchiveOpen(false);
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to archive project'),
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
        {projectQuery.isLoading && (
          <>
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-72 rounded-2xl" />
          </>
        )}

        {projectQuery.isError && (
          <SectionCard
            tone="destructive"
            title="Failed to load project"
            description={(projectQuery.error as Error).message}
          >
            <Button variant="outline" size="sm" onClick={() => projectQuery.refetch()}>
              Retry
            </Button>
          </SectionCard>
        )}

        {project && (
          <>
            <GeneralProjectCard project={project} canManage={!!canManage} />
            <RepositoryCard repoUrl={project.repo_url} />
            <SandboxSnapshotCard projectId={projectId} canManage={!!canManage} />
            <ProjectAccessCard
              projectId={projectId}
              canManage={!!canManage}
              members={accessQuery.data?.members ?? []}
              isLoading={accessQuery.isLoading}
              isError={accessQuery.isError}
              error={accessQuery.error as Error | null}
              onRetry={() => accessQuery.refetch()}
            />
            {canManage && (
              <SectionCard
                tone="destructive"
                title="Danger zone"
                description="Irreversible and destructive actions."
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Archive project</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Hide this project from the active project list.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Archive
                  </Button>
                </div>
              </SectionCard>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive project"
        description={project ? `Archive ${project.name}? Current sessions remain recoverable.` : ''}
        confirmLabel="Archive"
        onConfirm={() => archiveMutation.mutate()}
        isPending={archiveMutation.isPending}
      />
    </div>
  );
}

function RepositoryCard({ repoUrl }: { repoUrl: string | null | undefined }) {
  // Clone URL → human-friendly browser URL.
  const webUrl = (() => {
    if (!repoUrl) return null;
    return repoUrl
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '');
  })();
  const slug = webUrl?.replace('https://github.com/', '');

  return (
    <SectionCard
      title="Repository"
      description="The Git repo backing this project — every session pushes a branch here."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2.5">
          <Github className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-mono text-foreground">
            {slug || repoUrl || '—'}
          </span>
        </div>
        {webUrl && (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
          >
            <a href={webUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Open on GitHub
            </a>
          </Button>
        )}
      </div>
    </SectionCard>
  );
}

function GeneralProjectCard({
  project,
  canManage,
}: {
  project: Awaited<ReturnType<typeof getProject>>;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [defaultBranch, setDefaultBranch] = useState(project.default_branch);
  const [manifestPath, setManifestPath] = useState(project.manifest_path);

  useEffect(() => {
    setName(project.name);
    setDefaultBranch(project.default_branch);
    setManifestPath(project.manifest_path);
  }, [project.name, project.default_branch, project.manifest_path]);

  const mutation = useMutation({
    mutationFn: () =>
      updateProject(project.project_id, {
        name: name.trim(),
        default_branch: defaultBranch.trim(),
        manifest_path: manifestPath.trim(),
      }),
    onSuccess: (updated) => {
      toast.success('Project updated');
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to update project'),
  });

  const dirty =
    name.trim() !== project.name ||
    defaultBranch.trim() !== project.default_branch ||
    manifestPath.trim() !== project.manifest_path;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || !canManage) return;
    mutation.mutate();
  }

  return (
    <SectionCard title="General">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage || mutation.isPending}
            maxLength={120}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="default-branch">Default branch</Label>
            <Input
              id="default-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!canManage || mutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manifest-path">Manifest path</Label>
            <Input
              id="manifest-path"
              value={manifestPath}
              onChange={(e) => setManifestPath(e.target.value)}
              disabled={!canManage || mutation.isPending}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border/60 pt-4">
          <p className="truncate text-xs text-muted-foreground">
            {project.repo_url}
          </p>
          <Button type="submit" disabled={!dirty || !canManage || mutation.isPending} className="gap-1.5">
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
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
