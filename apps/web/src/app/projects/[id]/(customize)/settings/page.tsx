'use client';

import { FormEvent, use, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Github, Loader2, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  archiveProject,
  getProject,
  updateProject,
} from '@/lib/projects-client';
import { SandboxSnapshotCard } from '@/components/projects/sandbox-snapshot-card';

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

  const project = projectQuery.data;
  const canManage = project?.effective_project_role === 'manager';

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
