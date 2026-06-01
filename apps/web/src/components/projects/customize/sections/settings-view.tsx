'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  GitBranch,
  Loader2,
  Settings,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import {
  archiveProject,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  updateProject,
  type KortixProject,
} from '@/lib/projects-client';


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
            <RepositoryCard project={project} canManage={!!canManage} />
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

function RepositoryCard({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const repoUrl = project.repo_url;
  const githubUrl = githubRepoWebUrl(repoUrl);
  const repoLabel =
    githubUrl?.replace('https://github.com/', '') || repoUrl || '-';
  const managed = isManagedGithubProject(project);

  const [defaultBranch, setDefaultBranch] = useState(project.default_branch);
  const [manifestPath, setManifestPath] = useState(project.manifest_path);

  useEffect(() => {
    setDefaultBranch(project.default_branch);
    setManifestPath(project.manifest_path);
  }, [project.default_branch, project.manifest_path]);

  const mutation = useMutation({
    mutationFn: () =>
      updateProject(project.project_id, {
        default_branch: defaultBranch.trim(),
        manifest_path: manifestPath.trim(),
      }),
    onSuccess: (updated) => {
      toast.success('Repository updated');
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to update repository'),
  });

  const dirty =
    defaultBranch.trim() !== project.default_branch ||
    manifestPath.trim() !== project.manifest_path;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || !canManage) return;
    mutation.mutate();
  }

  return (
    <SectionCard
      title="Repository"
      description={tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line163JsxAttrDescriptionTheGitRepoBackingThisProjectEverySession')}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2.5">
          {githubUrl ? (
            <GithubMark className="h-4 w-4 shrink-0" />
          ) : (
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
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

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
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
        <div className="flex justify-end">
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

      {managed && (
        <RepoCollaboratorInvite projectId={project.project_id} />
      )}
    </SectionCard>
  );
}

/**
 * For a Kortix-managed GitHub repo: add GitHub users (including yourself) as
 * collaborators so they can clone/browse/work on the repo on github.com.
 */
function RepoCollaboratorInvite({ projectId }: { projectId: string }) {
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const inviteMutation = useMutation({
    mutationFn: () =>
      inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        toast.success(`@${res.username} already has access to this repo`);
      } else {
        toast.success(
          `Invite sent to @${res.username} — they accept it on GitHub to get access`,
        );
      }
      setUsername('');
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !inviteMutation.isPending) inviteMutation.mutate();
  };

  return (
    <div className="mt-6">
      <p className="text-sm font-medium text-foreground">Add people to this repo</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Kortix owns this repo. Add GitHub users as collaborators so they can clone,
        browse, and work on it directly on github.com.
      </p>
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={submit}>
        <div className="relative min-w-0 flex-1 basis-48">
          <GithubMark className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="GitHub username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pl-9"
          />
        </div>
        <Select
          value={permission}
          onValueChange={(v) => setPermission(v as 'read' | 'write')}
        >
          <SelectTrigger size="lg" className="w-[8.5rem] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="write">Can edit</SelectItem>
            <SelectItem value="read">Can view</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="lg"
          className="shrink-0 gap-1.5"
          disabled={!username.trim() || inviteMutation.isPending}
        >
          {inviteMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserPlus className="h-3.5 w-3.5" />
          )}
          Add
        </Button>
      </form>
    </div>
  );
}

/** GitHub mark rendered from Google's favicon service (per request). */
function GithubMark({ className }: { className?: string }) {
  return (
    <img
      src="https://www.google.com/s2/favicons?domain=github.com&sz=64"
      alt=""
      aria-hidden
      className={`rounded-[4px] ${className ?? ''}`}
    />
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

  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const mutation = useMutation({
    mutationFn: () =>
      updateProject(project.project_id, {
        name: name.trim(),
      }),
    onSuccess: (updated) => {
      toast.success('Project updated');
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to update project'),
  });

  const dirty = name.trim() !== project.name;

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
        <div className="flex justify-end">
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
