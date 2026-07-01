'use client';

import { useTranslations } from 'next-intl';

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/features/icon/icon';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  archiveProject,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  listProjectTriggers,
  setProjectTriggersActivation,
  updateExperimentalFeature,
  updateProject,
  updateProjectSandboxProvider,
  type ExperimentalFeatureView,
  type KortixProject,
  type ProjectDetail,
} from '@/lib/projects-client';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { TrashSolid } from '@mynaui/icons-react';
import CustomizeSectionWrapper from '../component/section-wrapper';

export function SettingsView({ projectId }: { projectId: string }) {
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
      successToast('Project archived');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setArchiveOpen(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to archive project'),
  });

  return (
    <CustomizeSectionWrapper title="Settings" description="Manage your project settings">
      {projectQuery.isLoading && (
        <div className="space-y-5">
          <Skeleton className="h-56 rounded-md" />
          <Skeleton className="h-72 rounded-md" />
        </div>
      )}

      {projectQuery.isError && (
        <ErrorState
          size="sm"
          title={tHardcodedUi.raw(
            'appProjectsIdCustomizeSettingsPage.line86JsxAttrTitleFailedToLoadProject',
          )}
          description={(projectQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => projectQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {project && (
        <div className="space-y-8">
          <GeneralProjectCard project={project} canManage={!!canManage} />
          <RepositoryCard project={project} canManage={!!canManage} />
          {canManage && (
            <section className="space-y-4">
              <Label>Automation</Label>
              <TriggersActivationCard projectId={projectId} canManage={!!canManage} />
            </section>
          )}
          <ExperimentalCard project={project} canManage={!!canManage} />
          {canManage && (
            <section className="space-y-4">
              <Label>
                {tHardcodedUi.raw(
                  'appProjectsIdCustomizeSettingsPage.line110JsxAttrTitleDangerZone',
                )}
              </Label>
              <div className="bg-popover rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line116JsxTextArchiveProject',
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line119JsxTextHideThisProjectFromTheActiveProjectList',
                      )}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    className="shrink-0"
                    size="sm"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <TrashSolid className="size-4" />
                    Archive
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

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
    </CustomizeSectionWrapper>
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
  const { debouncedValue: debouncedBranch, isLoading: isDebouncingBranch } = useDebounce(
    defaultBranch,
    500,
  );
  const { debouncedValue: debouncedManifest, isLoading: isDebouncingManifest } = useDebounce(
    manifestPath,
    500,
  );

  useEffect(() => {
    setDefaultBranch(project.default_branch);
    setManifestPath(project.manifest_path);
  }, [project.default_branch, project.manifest_path]);

  const mutation = useMutation({
    mutationFn: (patch: { default_branch: string; manifest_path: string }) =>
      updateProject(project.project_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update repository'),
  });

  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!canManage || isPending) return;

    const branch = debouncedBranch.trim();
    const manifest = debouncedManifest.trim();
    if (!branch) return;
    if (branch === project.default_branch && manifest === project.manifest_path) return;

    mutate({ default_branch: branch, manifest_path: manifest });
  }, [
    debouncedBranch,
    debouncedManifest,
    canManage,
    project.default_branch,
    project.manifest_path,
    isPending,
    mutate,
  ]);

  const saving = isDebouncingBranch || isDebouncingManifest || isPending;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label>Repository</Label>
        {githubUrl ? (
          <Button asChild variant="transparent" size="sm">
            <Link href={githubUrl} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="default-branch">
                {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}
              </FieldLabel>
              {saving ? <SaveStatus /> : null}
            </div>
            <Input
              id="default-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!canManage || isPending}
              className="font-mono text-xs"
              variant="popover"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="manifest-path">
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line280JsxTextManifestPath')}
            </FieldLabel>
            <Input
              id="manifest-path"
              value={manifestPath}
              onChange={(e) => setManifestPath(e.target.value)}
              disabled={!canManage || isPending}
              className="font-mono text-xs"
              variant="popover"
            />
          </Field>
        </FieldGroup>

        {managed ? (
          <div className="border-border/60 border-t pt-5">
            <RepoCollaboratorInvite projectId={project.project_id} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ExperimentalCard({ project, canManage }: { project: KortixProject; canManage: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const features = (project.experimental_features ?? []).filter((f) => f.available);
  const [expanded, setExpanded] = useState(false);

  if (features.length === 0) return null;

  return (
    <section className="space-y-4">
      <Label>
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextExperimentalWIPcb2304ee',
        )}
      </Label>
      <Disclosure
        open={expanded}
        onOpenChange={setExpanded}
        variant="outline"
        className="group bg-popover overflow-hidden"
      >
        <DisclosureTrigger className="px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">
              {features.length} feature{features.length === 1 ? '' : 's'}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
              Early-access capabilities that may change or be removed.
            </p>
          </div>
        </DisclosureTrigger>
        <DisclosureContent contentClassName="border-border border-t">
          <div className="divide-border divide-y">
            {features.map((feature) => (
              <ExperimentalFeatureRow
                key={feature.key}
                projectId={project.project_id}
                feature={feature}
                canManage={canManage}
              />
            ))}
            <SandboxProviderRow project={project} canManage={canManage} />
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
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
      queryClient.setQueryData<ProjectDetail | undefined>(
        ['project-detail', projectId],
        (current) => (current ? { ...current, project: updated } : current),
      );
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (feature.key === 'llm_gateway') {
        refreshProjectProviderState(queryClient, projectId, { removeProjectScopedCache: true });
      }
    },
    onError: (error: Error) => errorToast(error.message || `Failed to update ${feature.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">{feature.name}</p>
          <Badge variant={feature.stability === 'beta' ? 'beta' : 'highlight'} size="sm">
            {feature.stability === 'beta' ? 'Beta' : 'Experimental'}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{feature.description}</p>
      </div>
      <Switch
        checked={feature.enabled}
        disabled={!canManage || mutation.isPending}
        onCheckedChange={(v) => mutation.mutate(v)}
      />
    </div>
  );
}

// Per-project sandbox-provider pin — rendered as a row INSIDE the Experimental list.
// Overrides the platform's weighted distribution for THIS project only (e.g. put one
// project on Platinum even when the fleet is mostly Daytona). Options come from the
// project payload (`available_sandbox_providers` = the usable set). Hidden only when
// no provider is usable.
const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const available = project.available_sandbox_providers ?? [];
  const current = project.default_sandbox_provider ?? null;

  const mutation = useMutation({
    mutationFn: (next: string | null) => updateProjectSandboxProvider(project.project_id, next),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.setQueryData<ProjectDetail | undefined>(
        ['project-detail', project.project_id],
        (c) => (c ? { ...c, project: updated } : c),
      );
      queryClient.invalidateQueries({ queryKey: ['project-detail', project.project_id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">Sandbox provider</p>
          <Badge variant="highlight" size="sm">
            Experimental
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          Pin this project to a specific sandbox provider, overriding the platform
          default. New sessions here run on the chosen provider — “Automatic” follows
          the platform default.
        </p>
      </div>
      <Select
        value={current ?? AUTO_PROVIDER}
        onValueChange={(v) => mutation.mutate(v === AUTO_PROVIDER ? null : v)}
        disabled={!canManage || mutation.isPending}
      >
        <SelectTrigger className="w-40 shrink-0" variant="popover">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
          {available.map((p) => (
            <SelectItem key={p} value={p}>
              {label(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

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
      successToast(next ? 'All triggers paused for this project' : 'Triggers resumed');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update trigger activation'),
  });

  return (
    <Field orientation="horizontal" className="bg-popover rounded-md border px-4 py-3">
      <FieldContent>
        <FieldTitle>
          Pause all triggers
          {paused && <span className="text-muted-foreground font-normal"> · paused</span>}
        </FieldTitle>
        <FieldDescription>
          Dev kill-switch — stop the platform auto-running this project&apos;s schedules &amp;
          webhooks (manual test-fires still work). Use it when another environment owns the
          triggers.
        </FieldDescription>
      </FieldContent>
      <Switch
        checked={paused}
        disabled={!canManage || mutation.isPending || triggersQuery.isLoading}
        onCheckedChange={(v) => mutation.mutate(v)}
        aria-label="Pause all triggers for this project"
      />
    </Field>
  );
}

function RepoCollaboratorInvite({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const inviteMutation = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        successToast(`@${res.username} already has access to this repo`);
      } else {
        successToast(`Invite sent to @${res.username} — they accept it on GitHub to get access`);
      }
      setUsername('');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !inviteMutation.isPending) inviteMutation.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextAddPeople18915e9b',
          )}
        </p>
        <p className="text-muted-foreground text-xs text-pretty">
          Invite GitHub collaborators to this repository.
        </p>
      </div>

      <form onSubmit={submit}>
        <FieldGroup className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_auto] sm:items-end sm:gap-x-3">
            <Field>
              <div className="relative min-w-0">
                <Icon.Github className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  id="repo-collaborator-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsSettingsViewJsxAttrPlaceholderGitHub84efb7a1',
                  )}
                  variant="popover"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pl-9"
                />
              </div>
            </Field>

            <Field>
              <Select
                value={permission}
                onValueChange={(v) => setPermission(v as 'read' | 'write')}
              >
                <SelectTrigger
                  id="repo-collaborator-permission"
                  className="w-full"
                  variant="popover"
                >
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
            </Field>

            <Field>
              <Button
                type="submit"
                className="w-full shrink-0 sm:w-auto"
                disabled={!username.trim() || inviteMutation.isPending}
              >
                {inviteMutation.isPending ? <Loading className="size-3.5 animate-spin" /> : null}
                Add
              </Button>
            </Field>
          </div>
        </FieldGroup>
      </form>
    </div>
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
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);

  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const mutation = useMutation({
    mutationFn: (nextName: string) =>
      updateProject(project.project_id, {
        name: nextName,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update project'),
  });

  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!canManage || isPending) return;

    const trimmed = debouncedName.trim();
    if (!trimmed || trimmed === project.name) return;

    mutate(trimmed);
  }, [debouncedName, canManage, project.name, isPending, mutate]);

  const saving = isDebouncing || isPending;

  return (
    <section className="space-y-4">
      <Label htmlFor="project-name">General</Label>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="project-name">
            {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line259JsxTextProjectName')}
          </FieldLabel>
          {saving ? <SaveStatus /> : null}
        </div>
        <Input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage || isPending}
          maxLength={120}
          variant="popover"
        />
      </Field>
    </section>
  );
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}
