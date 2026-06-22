'use client';

import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Loader2,
  Pause,
  Settings,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';

import { CustomizeSectionHeader } from '@/features/workspace/customize/customize-section-header';
import { Badge } from '@/components/ui/badge';
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
import { Switch } from '@/components/ui/switch';
import {
  archiveProject,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  listProjectTriggers,
  setProjectTriggersActivation,
  updateExperimentalFeature,
  updateProject,
  type ExperimentalFeatureView,
  type KortixProject,
} from '@/lib/projects-client';

export function SettingsView({ projectId }: { projectId: string }) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
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
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeSettingsPage.line86JsxAttrTitleFailedToLoadProject',
            )}
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
            <RepositoryCard project={project} canManage={!!canManage} />
            <ExperimentalCard project={project} canManage={!!canManage} />
            {canManage && <TriggersActivationCard projectId={projectId} canManage={!!canManage} />}
            {canManage && (
              <SectionCard
                tone="destructive"
                title={tHardcodedUi.raw(
                  'appProjectsIdCustomizeSettingsPage.line110JsxAttrTitleDangerZone',
                )}
                description={tHardcodedUi.raw(
                  'appProjectsIdCustomizeSettingsPage.line111JsxAttrDescriptionIrreversibleAndDestructiveActions',
                )}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line116JsxTextArchiveProject',
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line119JsxTextHideThisProjectFromTheActiveProjectList',
                      )}
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
        title={tHardcodedUi.raw(
          'appProjectsIdCustomizeSettingsPage.line140JsxAttrTitleArchiveProject',
        )}
        description={project ? `Archive ${project.name}? Current sessions remain recoverable.` : ''}
        confirmLabel="Archive"
        onConfirm={() => archiveMutation.mutate()}
        isPending={archiveMutation.isPending}
      />
    </div>
  );
}

function RepositoryCard({ project, canManage }: { project: KortixProject; canManage: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const repoUrl = project.repo_url;
  const githubUrl = githubRepoWebUrl(repoUrl);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || repoUrl || '-';
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
    onError: (error: Error) => toast.error(error.message || 'Failed to update repository'),
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
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeSettingsPage.line163JsxAttrDescriptionTheGitRepoBackingThisProjectEverySession',
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {githubUrl ? (
            <GithubMark className="h-4 w-4 shrink-0" />
          ) : (
            <GitBranch className="text-muted-foreground h-4 w-4 shrink-0" />
          )}
          <span className="text-foreground truncate font-mono text-sm">{repoLabel}</span>
        </div>
        {githubUrl && (
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <a href={githubUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line181JsxTextOpenOnGithub')}
            </a>
          </Button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="default-branch">
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}
            </Label>
            <Input
              id="default-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!canManage || mutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manifest-path">
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line280JsxTextManifestPath')}
            </Label>
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

      {managed && <RepoCollaboratorInvite projectId={project.project_id} />}
    </SectionCard>
  );
}

/**
 * Customize → Settings → Experimental / WIP Features. Per-project switches for
 * soft-released features. The list is driven entirely by the API catalog
 * (project.experimental_features) — add a feature to the registry in
 * apps/api/src/experimental/features.ts and it shows up here automatically.
 *
 * These are real, usable surfaces that are still moving: turning one on opts
 * THIS project in. They may change shape or break between versions, so they
 * stay off until explicitly enabled. DB-only — never in kortix.toml.
 *
 * Deliberately tucked away: the card collapses to a single muted row and you
 * have to expand it to reveal the toggles, so WIP surfaces don't read as
 * first-class settings.
 */
function ExperimentalCard({ project, canManage }: { project: KortixProject; canManage: boolean }) {
  // Only features the platform actually supports are shown.

  const tI18nHardcoded = useTranslations('hardcodedUi');
  const features = (project.experimental_features ?? []).filter((f) => f.available);
  // Collapsed by default — extra expand to reveal.
  const [expanded, setExpanded] = useState(false);

  if (features.length === 0) return null;

  const enabledCount = features.filter((f) => f.enabled).length;

  return (
    <SectionCard className="border-dashed">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        <FlaskConical className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextExperimentalWIPcb2304ee',
            )}
            {enabledCount > 0 && (
              <span className="text-muted-foreground font-normal"> · {enabledCount} on</span>
            )}
          </p>
          {!expanded && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextSoftReleased8dc4e708',
              )}
            </p>
          )}
        </div>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextTheseAre75a29a6f',
            )}
          </p>
          <div className="divide-border border-border mt-2 divide-y border-t">
            {features.map((feature) => (
              <ExperimentalFeatureRow
                key={feature.key}
                projectId={project.project_id}
                feature={feature}
                canManage={canManage}
              />
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function ExperimentalFeatureRow({
  projectId,
  feature,
  canManage,
}: {
  projectId: string;
  feature: ExperimentalFeatureView;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (next: boolean) => updateExperimentalFeature(projectId, feature.key, next),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', projectId], updated);
      // Sidebar shortcuts gate off these same values via a separate
      // 'project-detail' query — refresh so surfaces appear/disappear.
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => toast.error(error.message || `Failed to update ${feature.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-4 py-4 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">{feature.name}</p>
          <Badge variant={feature.stability === 'beta' ? 'beta' : 'highlight'} size="sm">
            {feature.stability === 'beta' ? 'Beta' : 'Experimental'}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{feature.description}</p>
      </div>
      <Switch
        checked={feature.enabled}
        disabled={!canManage || mutation.isPending}
        onCheckedChange={(v) => mutation.mutate(v)}
      />
    </div>
  );
}

/**
 * Customize → Settings → Pause all triggers. The project-wide trigger
 * kill-switch (`projects.metadata.triggers_paused`), deliberately tucked away
 * here as a small dev/debug control rather than advertised on the Triggers tab:
 * it's only needed when another environment should own this repo's schedules &
 * webhooks (so they don't double-fire). When on, the platform auto-runs none of
 * this project's triggers; manual test-fires still work. The Triggers tab shows
 * a compact "paused" notice that points back here.
 */
function TriggersActivationCard({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['project-triggers', projectId];
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    staleTime: 10_000,
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;

  const mutation = useMutation({
    mutationFn: (next: boolean) => setProjectTriggersActivation(projectId, next),
    onSuccess: (data, next) => {
      queryClient.setQueryData(queryKey, data);
      toast.success(next ? 'All triggers paused for this project' : 'Triggers resumed');
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to update trigger activation'),
  });

  return (
    <SectionCard className="border-dashed">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <Pause className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              Pause all triggers
              {paused && <span className="text-muted-foreground font-normal"> · paused</span>}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Dev kill-switch — stop the platform auto-running this project&apos;s schedules &amp;
              webhooks (manual test-fires still work). Use it when another environment owns the
              triggers.
            </p>
          </div>
        </div>
        <Switch
          checked={paused}
          disabled={!canManage || mutation.isPending || triggersQuery.isLoading}
          onCheckedChange={(v) => mutation.mutate(v)}
          aria-label="Pause all triggers for this project"
        />
      </div>
    </SectionCard>
  );
}

/**
 * For a Kortix-managed GitHub repo: add GitHub users (including yourself) as
 * collaborators so they can clone/browse/work on the repo on github.com.
 */
function RepoCollaboratorInvite({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const inviteMutation = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        toast.success(`@${res.username} already has access to this repo`);
      } else {
        toast.success(`Invite sent to @${res.username} — they accept it on GitHub to get access`);
      }
      setUsername('');
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !inviteMutation.isPending) inviteMutation.mutate();
  };

  return (
    <div className="mt-6">
      <p className="text-foreground text-sm font-medium">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextAddPeople18915e9b',
        )}
      </p>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextKortixOwns7b6690bc',
        )}
      </p>
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={submit}>
        <div className="relative min-w-0 flex-1 basis-48">
          <GithubMark className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSettingsViewJsxAttrPlaceholderGitHub84efb7a1',
            )}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pl-9"
          />
        </div>
        <Select value={permission} onValueChange={(v) => setPermission(v as 'read' | 'write')}>
          <SelectTrigger size="lg" className="w-[8.5rem] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="write">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextCanEdit2eb88c1b',
              )}
            </SelectItem>
            <SelectItem value="read">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextCanView39f4dd36',
              )}
            </SelectItem>
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
    onError: (error: Error) => toast.error(error.message || 'Failed to update project'),
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
          <Label htmlFor="project-name">
            {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line259JsxTextProjectName')}
          </Label>
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
