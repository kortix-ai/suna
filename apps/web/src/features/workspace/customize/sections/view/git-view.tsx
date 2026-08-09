'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import Hint from '@/components/ui/hint';
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
import { Github as GithubIcon } from '@/features/icon/icons/github';
import { ErrorState } from '@/features/layout/section/error-state';
import { useDebounce } from '@/hooks/use-debounce';
import { getEnv } from '@/lib/env-config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProjectDetail,
  inviteRepoCollaborator,
  isManagedGithubProject,
  listProjectBranches,
  updateProject,
  type KortixProject,
  type ProjectDetail,
  type ProjectGitConnection,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon as RefreshCw,
  ArrowSquareOutIcon as ExternalLink,
  CheckIcon as Check,
  CopyIcon as Copy,
  GitBranchIcon as GitBranch,
  GithubLogoIcon as Github,
  GitForkIcon as GitFork,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { type FormEvent, useEffect, useState } from 'react';

import CustomizeSectionWrapper from '../component/section-wrapper';
import { providerLabel, repositoryWebUrl } from './git-view-helpers';

type ProjectWithOrigin = KortixProject & { git_origin_url?: string };

function proxyUrl(project: ProjectWithOrigin): string {
  if (project.git_origin_url) return project.git_origin_url;
  const configured = getEnv().BACKEND_URL.replace(/\/+$/, '');
  const base = configured.startsWith('http')
    ? configured
    : `${typeof window === 'undefined' ? '' : window.location.origin}${configured}`;
  const versioned = base.endsWith('/v1') ? base : `${base}/v1`;
  return `${versioned}/git/${project.project_id}.git`;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      successToast(`${label} copied`);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      errorToast(`Could not copy ${label.toLowerCase()}`);
    }
  };

  return (
    <div className="border-border bg-muted/40 flex min-w-0 items-center gap-2 rounded-md border px-3 py-2.5">
      <code className="text-foreground min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        {value}
      </code>
      <Hint label={copied ? 'Copied' : `Copy ${label}`}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0 transition-transform active:scale-[0.96]"
          onClick={copy}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
        >
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={copied ? 'check' : 'copy'}
                initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {copied ? (
                  <Check className="text-kortix-green size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </m.span>
            </AnimatePresence>
          </span>
        </Button>
      </Hint>
    </div>
  );
}

function ConnectionSummary({
  connection,
}: {
  connection: ProjectGitConnection | null | undefined;
}) {
  const connected = connection?.status === 'connected';
  const webUrl = connection?.repo_url
    ? repositoryWebUrl(connection.provider, connection.repo_url)
    : null;
  return (
    <div className="divide-border divide-y overflow-hidden rounded-md border">
      <SummaryRow
        label="Provider"
        value={providerLabel(connection?.provider)}
        icon={<GitFork className="size-4" />}
      />
      <SummaryRow
        label="Repository"
        value={
          connection?.repo_owner && connection.repo_name
            ? `${connection.repo_owner}/${connection.repo_name}`
            : connection?.repo_url || 'Repository'
        }
        icon={
          connection?.provider === 'github' ? (
            <Github className="size-4" />
          ) : (
            <GitFork className="size-4" />
          )
        }
        href={webUrl}
      />
      <SummaryRow
        label="Default branch"
        value={connection?.default_branch || 'main'}
        icon={<GitBranch className="size-4" />}
      />
      <div className="flex items-center justify-between gap-4 px-3.5 py-3">
        <span className="text-muted-foreground text-sm">Connection health</span>
        <Badge variant={connected ? 'success' : 'secondary'} size="sm">
          {connected ? 'Connected' : connection?.status || 'Unknown'}
        </Badge>
      </div>
      {connection?.last_error_message ? (
        <div className="bg-destructive/5 text-destructive px-3.5 py-3 text-sm">
          {connection.last_error_message}
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  icon,
  href,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  href?: string | null;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground w-28 shrink-0 text-sm">{label}</span>
      {href?.startsWith('http') ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-foreground ml-auto flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline"
        >
          <span className="truncate">{value}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
      ) : (
        <span className="text-foreground ml-auto min-w-0 truncate text-sm font-medium">
          {value}
        </span>
      )}
    </div>
  );
}

/**
 * `githubRepoWebUrl` normalizes a project's raw `repo_url` (SSH or HTTPS,
 * possibly `.git`-suffixed) into a browsable GitHub URL — moved verbatim
 * from `settings-view.tsx`'s `RepositoryCard`. NOT the same job as this
 * file's own `repositoryWebUrl` (`git-view-helpers.ts`): that one only
 * strips a trailing `.git` off an ALREADY-web-form `connection.repo_url`
 * (from `git_connection`, provider-tagged) and is generic across
 * GitHub/GitLab. This one parses `project.repo_url` (a different field,
 * frequently still in SSH form, GitHub-only) — two different inputs, so
 * reusing `repositoryWebUrl` here would either lose the SSH-parsing case or
 * force it to grow a GitHub-specific branch it doesn't need for its own
 * caller (`ConnectionSummary` below).
 */
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

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}

/**
 * Default branch, manifest path, and (for a Kortix-managed GitHub repo) a
 * collaborator invite form — moved verbatim (cut, not copied) from
 * `settings-view.tsx`'s `RepositoryCard`/`RepoCollaboratorInvite`. Previously
 * lived on the (now-unreachable) General tab; rehomed here because default
 * branch/manifest path/collaborator access are repository concerns, and this
 * is the Repositories tab. `canManage` carries the same manager-OR-
 * `project.write` gate the original had — see `GitView`'s own comment on how
 * it derives that without a second project fetch.
 */
function RepositoryCard({ project, canManage }: { project: KortixProject; canManage: boolean }) {
  const queryClient = useQueryClient();
  const repoUrl = project.repo_url;
  const githubUrl = githubRepoWebUrl(repoUrl);
  const managed = isManagedGithubProject(project);
  const branchesQuery = useQuery({
    queryKey: qk.project.branches(project.project_id),
    queryFn: () => listProjectBranches(project.project_id),
    ...contract('config'),
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
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
      queryClient.setQueryData<ProjectDetail | undefined>(
        qk.project.detail(project.project_id),
        (current) => (current ? { ...current, project: updated } : current),
      );
      // qk.projects.scope(): reaches every account's list (and the
      // accountless slot the marketplace picker reads), restoring the reach
      // the old bare projects-literal prefix match had. Repo-settings edits
      // are rare — over-invalidating costs nothing.
      queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      queryClient.invalidateQueries({ queryKey: qk.project.branches(project.project_id) });
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
          <h3 className="text-foreground text-sm font-medium">Repository settings</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            The base branch new sessions and change requests use, and where the manifest lives.
          </p>
        </div>
        {githubUrl ? (
          <Button asChild variant="transparent" size="sm">
            <a href={githubUrl} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </Button>
        ) : null}
      </div>

      <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="default-branch">Default branch</FieldLabel>
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
            <FieldLabel htmlFor="manifest-path">Manifest path</FieldLabel>
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
        <p className="text-foreground text-sm font-medium">Add people</p>
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
                  <GithubIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                  <Input
                    id="repo-collaborator-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="GitHub username"
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
                    <SelectItem value="write">Can edit</SelectItem>
                    <SelectItem value="read">Can view</SelectItem>
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

export function GitView({ projectId }: { projectId: string }) {
  const installCommand = useDeploymentCliInstallCommand(getEnv().VERSION);
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  // `detail.data.project` is a full `KortixProject` (same shape
  // `settings-view.tsx`'s now-removed `SettingsView` fetched separately via
  // `getProject`) — GitView already fetches it for `ConnectionSummary`, so
  // `RepositoryCard` below reuses this SAME query instead of firing a second
  // project fetch just for its own `effective_project_role`/`repo_url`/
  // `default_branch`/`manifest_path`.
  const project = detail.data?.project;
  const canManage = project?.effective_project_role === 'manager';
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  return (
    <CustomizeSectionWrapper
      title="Git"
      description="Repository hosting, authenticated local development, and synchronization."
    >
      {detail.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {detail.isError ? (
        <ErrorState
          size="sm"
          title="Could not load Git settings"
          description={(detail.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => detail.refetch()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : null}
      {detail.data ? (
        <div className="space-y-8">
          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Repository</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                The provider and repository backing every project session.
              </p>
            </div>
            <ConnectionSummary connection={detail.data.git_connection} />
          </section>

          {project ? <RepositoryCard project={project} canManage={canEdit} /> : null}

          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Develop locally</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Install the CLI, then clone through the authenticated Kortix proxy. Tokens are never
                saved in the URL or Git config.
              </p>
            </div>
            <CopyValue value={installCommand} label="Install command" />
            <CopyValue value={`kortix projects clone ${projectId}`} label="Clone command" />
            <p className="text-muted-foreground text-xs">
              Then run <code className="text-foreground font-mono">kortix init --force</code> and{' '}
              <code className="text-foreground font-mono">kortix env pull</code> inside the cloned
              directory.
            </p>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Kortix proxy origin</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Sessions and the Kortix CLI use this stable URL; Kortix resolves the current
                provider credential just in time.
              </p>
            </div>
            <CopyValue
              value={proxyUrl(detail.data.project as ProjectWithOrigin)}
              label="Proxy URL"
            />
          </section>
        </div>
      ) : null}
    </CustomizeSectionWrapper>
  );
}
