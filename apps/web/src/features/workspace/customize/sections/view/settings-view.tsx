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
import type { GlyphSelection } from '@/components/ui/glyph-picker';
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
import { Github } from '@/features/icon/icons/github';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  buildProjectEditPatch,
  type ProjectEditDraft,
  type ProjectEditSubject,
} from '@/features/projects/modal/project-edit-patch';
import { ProjectIconField, type ProjectIconValue } from '@/features/projects/modal/project-icon-field';
import { suppressAutoProjectAfterDelete } from '@/lib/onboarding/ensure-first-project';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  archiveProject,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  listProjectBranches,
  listProjectsForAccount,
  listProjectTriggers,
  setProjectTriggersActivation,
  updateExperimentalFeature,
  updateProject,
  updateProjectSandboxProvider,
  type ExperimentalFeatureView,
  type KortixProject,
  type ProjectDetail,
  type ProjectInput,
  type SandboxProviderName,
} from '@kortix/sdk';
import { refreshProjectProviderState } from '@kortix/sdk/react';
import { TrashIcon } from '@phosphor-icons/react';
import CustomizeSectionWrapper from '../component/section-wrapper';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from './sandbox-provider-result';

export interface RunProjectArchiveClient {
  archiveProject: (projectId: string) => Promise<unknown>;
}

/**
 * The archive mutation's real side effects, pulled out of the component so
 * this exact wiring can be pinned with a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling suites (see ensure-first-project.provision.test.ts /
 * use-create-workspace.test.ts, which use this same injected-client shape).
 *
 * Ported from the deleted `/projects` list page's archive handler
 * (`app/(app)/projects/page.tsx`, pre-Task-21): "Archiving the LAST project
 * must leave the account empty. Without this the auto-provision door would
 * see zero active projects and immediately recreate one, undoing the delete
 * the user just confirmed." Same condition (`<= 1`, evaluated against the
 * project count from BEFORE this archive lands), same tab-scoped
 * `sessionStorage` guard (`suppressAutoProjectAfterDelete`) — deliberately
 * NOT `localStorage`: a later sign-in or a fresh tab must still auto-provision
 * for an empty account like any other.
 *
 * `onSuppress` only runs after `client.archiveProject` resolves — a failed
 * archive must not suppress auto-provision for a project that still exists.
 *
 * `remainingProjectCountBeforeArchive` is `number | null`, NOT the deleted
 * page's plain number: that page's count and its Archive button read the
 * SAME query, so the button could not render before the count existed. Here
 * the count is a separate, dependent query (`accountProjectsQuery`) that can
 * still be loading or errored when Archive is clicked. `null` means "count
 * unknown" and deliberately does NOT suppress — failing closed, because the
 * cost of skipping a suppression is one unwanted auto-create, while the cost
 * of a FALSE suppression (from an unrelated `?? 0`) is `/projects/start`
 * refusing to auto-create for the next empty account this tab visits, with
 * nothing left to clear the flag until this same terminal screen is reached
 * again for an account where it actually applies.
 */
export async function runProjectArchive(
  projectId: string,
  remainingProjectCountBeforeArchive: number | null,
  client: RunProjectArchiveClient,
  onSuppress: () => void,
): Promise<void> {
  await client.archiveProject(projectId);
  if (remainingProjectCountBeforeArchive !== null && remainingProjectCountBeforeArchive <= 1) {
    onSuppress();
  }
}

/**
 * `accountProjectsQuery.data` -> the count `runProjectArchive` needs, kept as
 * its own exported step so the exact mapping is pinned independently of
 * TanStack Query. The bug this guards against lived in a bare
 * `accountProjectsQuery.data?.length ?? 0` at the call site: `undefined`
 * (still loading, OR the query errored — react-query leaves `data`
 * `undefined` in both) silently became `0`, which reads as "zero projects
 * remain" and fires a false suppression. `undefined` must map to `null`
 * ("unknown"), never to `0` ("confirmed empty").
 */
export function accountProjectCountForArchive(data: unknown[] | undefined): number | null {
  return data ? data.length : null;
}

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
  // Real per-leaf write cap: a custom role granted project.write edits the
  // general controls (name/repo/experimental) without being a full manager.
  // The mutating routes assert project.write, so a READ-only role sees the
  // section read-only. Archive/danger-zone stays manager-only below.
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  // Same ['projects', accountId] cache key the workspace switcher and /new
  // already fetch with, so this is warm (no extra request) for the common
  // case of opening Settings from a project the sidebar has already loaded.
  // Read, not re-derived from `project`: this is the account's PROJECT
  // COUNT before the archive commits, which `runProjectArchive` needs to
  // decide whether this was the last one.
  const accountId = project?.account_id;
  const accountProjectsQuery = useQuery({
    queryKey: ['projects', accountId],
    queryFn: () => listProjectsForAccount(accountId as string),
    enabled: !!accountId,
    staleTime: 20_000,
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      runProjectArchive(
        projectId,
        accountProjectCountForArchive(accountProjectsQuery.data),
        { archiveProject },
        suppressAutoProjectAfterDelete,
      ),
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
          <GeneralProjectCard project={project} canManage={canEdit} />
          <RepositoryCard project={project} canManage={canEdit} />
          {canManage && (
            <section className="space-y-4">
              <Label>Automation</Label>
              <TriggersActivationCard projectId={projectId} canManage={canEdit} />
            </section>
          )}
          <ExperimentalCard project={project} canManage={canEdit} />
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
                    <TrashIcon className="size-4" />
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
  const branchesQuery = useQuery({
    queryKey: ['project-branches', project.project_id],
    queryFn: () => listProjectBranches(project.project_id),
    staleTime: 60_000,
  });
  const branchNames = Array.from(
    new Set([
      project.default_branch,
      ...(branchesQuery.data?.branches.map((branch) => branch.name) ?? []),
    ]),
  );

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
      queryClient.invalidateQueries({ queryKey: ['project-branches', project.project_id] });
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
            <Select
              value={defaultBranch}
              onValueChange={setDefaultBranch}
              disabled={!canManage || isPending}
            >
              <SelectTrigger id="default-branch" className="font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((branch) => (
                  <SelectItem key={branch} value={branch} className="font-mono text-xs">
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              New sessions and change requests use this branch as their base.
            </FieldDescription>
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
            <RepoCollaboratorInvite projectId={project.project_id} canManage={canManage} />
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
  // Show the intended position while the request is in flight. `feature.enabled`
  // only reflects server state, so without this the switch does not move at all
  // until the mutation resolves and a slow request looks like a frozen toggle.
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const mutation = useMutation({
    mutationFn: (next: boolean) => updateExperimentalFeature(projectId, feature.key, next),
    onSettled: () => setPendingValue(null),
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
      <div className="flex shrink-0 items-center gap-2">
        {mutation.isPending ? <Loading className="text-muted-foreground size-3.5" /> : null}
        <Switch
          checked={pendingValue ?? feature.enabled}
          disabled={!canManage || mutation.isPending}
          onCheckedChange={(v) => {
            setPendingValue(v);
            mutation.mutate(v);
          }}
        />
      </div>
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
  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateProjectSandboxProvider(project.project_id, next),
    onSuccess: (result, next) => {
      // FIX-L: the PATCH returns EITHER the updated project (immediate) OR a
      // preparation object (the prepare branch — a switch to a different enabled
      // provider). Write the project cache ONLY for the immediate result; a
      // preparation is a transition, not a project, and must not clobber the
      // cached project shape.
      const kind = applySandboxProviderResult(queryClient, project.project_id, result);
      if (kind === 'preparation') {
        successToast(
          `Preparing ${next ? label(next) : 'the sandbox provider'}… this can take a few minutes`,
        );
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 = done)
        // and refresh the project once it settles so the now-active provider shows.
        void pollSandboxProviderTransition(project.project_id, {
          onSettled: (state) => {
            queryClient.invalidateQueries({ queryKey: ['project', project.project_id] });
            queryClient.invalidateQueries({ queryKey: ['project-detail', project.project_id] });
            queryClient.invalidateQueries({ queryKey: ['projects'] });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(`Switched to ${label(state?.latest?.target_provider ?? '')}`);
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || 'Sandbox provider switch failed');
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

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
          Pin this project to a specific sandbox provider, overriding the platform default. New
          sessions here run on the chosen provider — “Automatic” follows the platform default.
        </p>
      </div>
      <Select
        value={current ?? AUTO_PROVIDER}
        onValueChange={(v) =>
          mutation.mutate(
            v === AUTO_PROVIDER ? null : (available.find((provider) => provider === v) ?? null),
          )
        }
        disabled={!canManage || mutation.isPending}
      >
        <SelectTrigger className="w-40 shrink-0">
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

function RepoCollaboratorInvite({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
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
    if (!canManage) return;
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

      {canManage ? (
        <form onSubmit={submit}>
          <FieldGroup className="gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_auto] sm:items-end sm:gap-x-3">
              <Field>
                <div className="relative min-w-0">
                  <Github className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
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
                  <SelectTrigger id="repo-collaborator-permission" className="w-full">
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
                  {inviteMutation.isPending ? <Loading className="size-3.5" /> : null}
                  Add
                </Button>
              </Field>
            </div>
          </FieldGroup>
        </form>
      ) : null}
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

/**
 * The field's union, seeded from the project's two independent stored
 * columns. Glyph wins if — despite the server invariant — a stale row
 * somehow carries both, matching `EntityAvatar`'s own glyph > emoji
 * precedence rather than inventing a different tiebreak here. Ported from
 * the deleted `EditProjectModal`, which needed the identical seed.
 */
function toIconValue(icon?: string | null, glyph?: GlyphSelection | null): ProjectIconValue {
  if (glyph) return { glyph };
  if (icon) return { emoji: icon };
  return null;
}

/**
 * What `GeneralProjectCard`'s combined name+icon autosave sends to
 * `updateProject`, or `null` when there is nothing to send — pulled out so
 * this exact wiring is under test without mounting the component or mocking
 * `@kortix/sdk` (same DI shape `runProjectArchive` above uses, and for the
 * same reason: `mock.module('@kortix/sdk', ...)` is process-wide in this
 * monorepo and a hazard for sibling suites).
 *
 * Thin wrapper over `buildProjectEditPatch` (`project-edit-patch.ts`), which
 * already owns the union-diffing rules — including the invariant this field
 * exists to prove: `icon` and `icon_glyph` are never both present in the same
 * patch, because the API deletes whichever one a write does NOT name. This
 * function only pins what THIS card feeds that shared diff: the live project
 * as `subject`, the name input plus the icon field's current value as
 * `draft`.
 */
export function buildProjectSavePatch(
  subject: ProjectEditSubject,
  draft: ProjectEditDraft,
): Partial<ProjectInput> | null {
  const edit = buildProjectEditPatch(subject, draft);
  return edit.status === 'ready' ? edit.patch : null;
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
  const [icon, setIcon] = useState<ProjectIconValue>(() =>
    toIconValue(project.icon, project.icon_glyph),
  );
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);

  useEffect(() => {
    setName(project.name);
    setIcon(toIconValue(project.icon, project.icon_glyph));
  }, [project.name, project.icon, project.icon_glyph]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => updateProject(project.project_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', project.project_id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update project'),
  });

  const { mutate, isPending } = mutation;

  // One effect for both fields, same shape as `RepositoryCard`'s combined
  // branch+manifest save below. Name still only fires once its debounce
  // settles; the icon field is a discrete pick (not continuous typing), so
  // it saves the moment `icon` changes — no artificial delay, matching
  // `ExperimentalFeatureRow`'s switch. `buildProjectSavePatch` computes the
  // diff against the LIVE project on every run, so an icon pick made mid-name
  // -edit (before the debounce settles) sends only the icon key, never a
  // half-typed name.
  useEffect(() => {
    if (!canManage || isPending) return;

    const patch = buildProjectSavePatch(
      { name: project.name, icon: project.icon, icon_glyph: project.icon_glyph },
      { name: debouncedName, icon },
    );
    if (!patch) return;

    mutate(patch);
  }, [
    debouncedName,
    icon,
    canManage,
    project.name,
    project.icon,
    project.icon_glyph,
    isPending,
    mutate,
  ]);

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
        {/* Icon trigger as a peer of the name input, not a field of its own —
            same row treatment the deleted create/edit modals and `/new` use
            for the identical pairing (`items-start`: both controls are 9
            units tall today, and it stays correct if the input ever grows a
            second line). `onClear` IS passed here — unlike `/new`'s create
            surface, this project's icon is already saved, so removing it is
            a real, undoable-only-by-picking-again action. */}
        <div className="flex items-start gap-2">
          <ProjectIconField
            value={icon}
            onChange={(emoji) => setIcon({ emoji })}
            onGlyphChange={(glyph) => setIcon({ glyph })}
            onClear={() => setIcon(null)}
            disabled={!canManage || isPending}
          />
          <div className="min-w-0 flex-1">
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage || isPending}
              maxLength={120}
              variant="popover"
            />
          </div>
        </div>
      </Field>
    </section>
  );
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}
