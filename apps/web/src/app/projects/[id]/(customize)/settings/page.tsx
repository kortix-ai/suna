'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, use, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  Settings,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import {
  archiveProject,
  getProject,
  updateProject,
} from '@/lib/projects-client';

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
      <CustomizeSectionHeader icon={Settings} title="Settings" />
      <ProjectSettingsBody projectId={projectId} />
    </div>
  );
}

function ProjectSettingsBody({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to archive project'),
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
            title={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line86JsxAttrTitleFailedToLoadProject')}
            description={(projectQuery.error as Error).message}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => projectQuery.refetch()}
            >
              Retry
            </Button>
          </SectionCard>
        )}

        {project && (
          <>
            <GeneralProjectCard project={project} canManage={!!canManage} />
            <RepositoryCard repoUrl={project.repo_url} />
            {canManage && (
              <SectionCard
                tone="destructive"
                title={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line110JsxAttrTitleDangerZone')}
                description={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line111JsxAttrDescriptionIrreversibleAndDestructiveActions')}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line116JsxTextArchiveProject')}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line119JsxTextHideThisProjectFromTheActiveProjectList')}</p>
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
        title={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line140JsxAttrTitleArchiveProject')}
        description={
          project
            ? `Archive ${project.name}? Current sessions remain recoverable.`
            : ''
        }
        confirmLabel="Archive"
        onConfirm={() => archiveMutation.mutate()}
        isPending={archiveMutation.isPending}
      />
    </div>
  );
}

function RepositoryCard({ repoUrl }: { repoUrl: string | null | undefined }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const githubUrl = githubRepoWebUrl(repoUrl);
  const repoLabel =
    githubUrl?.replace('https://github.com/', '') || repoUrl || '-';
  const RepoIcon = githubUrl ? Github : GitBranch;

  return (
    <SectionCard
      title="Repository"
      description={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line163JsxAttrDescriptionTheGitRepoBackingThisProjectEverySession')}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2.5">
          <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-mono text-foreground">
            {repoLabel}
          </span>
        </div>
        {githubUrl && (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
          >
            <a href={githubUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line181JsxTextOpenOnGithub')}</a>
          </Button>
        )}
      </div>
    </SectionCard>
  );
}

function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return null;

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) {
    return `https://github.com/${ssh[1]}/${ssh[2]}`;
  }

  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) {
    return `https://github.com/${https[1]}/${https[2]}`;
  }

  return null;
}

function GeneralProjectCard({
  project,
  canManage,
}: {
  project: Awaited<ReturnType<typeof getProject>>;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to update project'),
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
          <Label htmlFor="project-name">{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line259JsxTextProjectName')}</Label>
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
            <Label htmlFor="default-branch">{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}</Label>
            <Input
              id="default-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!canManage || mutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manifest-path">{tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line280JsxTextManifestPath')}</Label>
            <Input
              id="manifest-path"
              value={manifestPath}
              onChange={(e) => setManifestPath(e.target.value)}
              disabled={!canManage || mutation.isPending}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <Button
            type="submit"
            disabled={!dirty || !canManage || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
