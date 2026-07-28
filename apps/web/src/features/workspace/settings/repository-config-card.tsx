'use client';

/**
 * Repository configuration — the editable half of the Repository tab.
 *
 * This used to live in the General tab as `RepositoryCard` while the Git tab
 * showed the same repository's provider, name and default branch read-only.
 * Two tabs, one repository, overlapping metadata. The card moved here so the
 * Repository tab is the single place the repository is both described and
 * configured; nothing was dropped in the move.
 *
 * It resolves the project itself (same `['project', id]` cache key the rest of
 * Settings uses, so no extra request) rather than taking it as a prop: the
 * project-detail payload that the Git summary reads is a different shape, and
 * an absent `manifest_path` there would debounce-save an empty path.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { useDebounce } from '@/hooks/use-debounce';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type KortixProject,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  listProjectBranches,
  updateProject,
} from '@kortix/sdk';

/** The GitHub web page for a repo URL, or null when it is not a GitHub repo. */
export function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
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

export function RepositoryConfigCard({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });
  // Same per-leaf write cap Settings applies elsewhere: a custom role granted
  // project.write edits these controls without being a full manager.
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const project = projectQuery.data;
  const canManage = project?.effective_project_role === 'manager' || canWrite;

  if (projectQuery.isLoading) return <Skeleton className="h-56 w-full rounded-md" />;
  if (!project) return null;

  return <RepositorySettings project={project} canManage={canManage} />;
}

function RepositorySettings({
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
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-foreground text-sm font-medium">Configuration</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            The branch new sessions branch from, and where the manifest lives.
          </p>
        </div>
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
              <SelectTrigger id="default-branch" className="font-mono text-xs" variant="popover">
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

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}

export default RepositoryConfigCard;
