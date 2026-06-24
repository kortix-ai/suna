'use client';

import { useTranslations } from 'next-intl';

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

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
  type ExperimentalFeatureView,
  type KortixProject,
} from '@/lib/projects-client';
import { TrashSolid } from '@mynaui/icons-react';
import CustomizeSectionWrapper from '../component/section-wrapper';

const panelClass = 'bg-popover border-border overflow-hidden rounded-md border px-2 py-3';

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
    <CustomizeSectionWrapper
      title="Settings"
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeSettingsPage.line111JsxAttrDescriptionIrreversibleAndDestructiveActions',
      )}
    >
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
        <>
          <GeneralProjectCard project={project} canManage={!!canManage} />
          <RepositoryCard project={project} canManage={!!canManage} />
          <ExperimentalCard project={project} canManage={!!canManage} />
          {canManage && <TriggersActivationCard projectId={projectId} canManage={!!canManage} />}
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
                    onClick={() => setArchiveOpen(true)}
                  >
                    <TrashSolid className="size-4" />
                    Archive
                  </Button>
                </div>
              </div>
            </section>
          )}
        </>
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
      successToast('Repository updated');
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update repository'),
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
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor="project-name">Repository</Label>

        <Button asChild variant="transparent" size="sm">
          <Link href={githubUrl ?? ''} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </Link>
        </Button>
      </div>

      <div className="space-y-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="default-branch">
                {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}
              </FieldLabel>
              <Input
                id="default-branch"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                disabled={!canManage || mutation.isPending}
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
                disabled={!canManage || mutation.isPending}
                className="font-mono text-xs"
                variant="popover"
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={!dirty || !canManage || mutation.isPending}
              className="gap-1.5"
            >
              {mutation.isPending ? <Loading className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>

        {managed && <RepoCollaboratorInvite projectId={project.project_id} />}
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
    <Disclosure
      open={expanded}
      onOpenChange={setExpanded}
      variant="outline"
      className="group bg-popover overflow-hidden"
    >
      <DisclosureTrigger className="px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextExperimentalWIPcb2304ee',
            )}
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
        </div>
      </DisclosureContent>
    </Disclosure>
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
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
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
    <section className="space-y-4">
      <Label htmlFor="repo-collaborator-username">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextAddPeople18915e9b',
        )}
      </Label>

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
    </section>
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
      successToast('Project updated');
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update project'),
  });

  const dirty = name.trim() !== project.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || !canManage) return;
    mutation.mutate();
  }

  return (
    <section className="space-y-4">
      <Label htmlFor="project-name">General</Label>
      <div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="project-name">
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line259JsxTextProjectName')}
            </FieldLabel>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage || mutation.isPending}
              maxLength={120}
              variant="popover"
            />
          </Field>
          <div className="ml-auto flex w-full items-center justify-end sm:w-auto">
            <Button type="submit" size="sm" disabled={!dirty || !canManage || mutation.isPending}>
              {mutation.isPending ? <Loading className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
