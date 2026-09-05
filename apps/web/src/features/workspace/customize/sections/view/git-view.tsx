'use client';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Github as GithubIcon } from '@/features/icon/icons/github';
import { ErrorState } from '@/features/layout/section/error-state';
import { useDebounce } from '@/hooks/use-debounce';
import { getEnv } from '@/lib/env-config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
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
import {
  CaretDownIcon,
  ArrowSquareOutIcon as ExternalLink,
  GitForkIcon as GitFork,
  GithubLogoIcon as Github,
  ArrowClockwiseIcon as RefreshCw,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import {
  connectionStatusLabel,
  providerLabel,
  providerSentence,
  repositoryWebUrl,
  type ConnectionTone,
} from './git-view-helpers';

/**
 * The leaves this view gates on, as ONE stable list.
 *
 * Action-list identity is part of the SDK's `effective:batch` query key, so a
 * literal rebuilt on each render would mint a new cache entry every time.
 * Module scope is what collapses both gates into a single request.
 */
const GIT_VIEW_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
] as const;

const DOCS_CLI = '/docs/cli';
const DOCS_MANIFEST = '/docs/project/manifest';

type ProjectWithOrigin = KortixProject & { git_origin_url?: string };

/**
 * The address a plain `git` client clones from. Kept as the project's own
 * `git_origin_url` when the backend supplies one, and otherwise rebuilt from
 * the configured backend URL — unchanged from the previous implementation
 * apart from its name, which used to be `proxyUrl`. "Proxy" is the mechanism;
 * every place this value now surfaces calls it a clone address, because that
 * is the only thing a user does with it.
 */
function gitCloneUrl(project: ProjectWithOrigin): string {
  if (project.git_origin_url) return project.git_origin_url;
  const configured = getEnv().BACKEND_URL.replace(/\/+$/, '');
  const base = configured.startsWith('http')
    ? configured
    : `${typeof window === 'undefined' ? '' : window.location.origin}${configured}`;
  const versioned = base.endsWith('/v1') ? base : `${base}/v1`;
  return `${versioned}/git/${project.project_id}.git`;
}

/**
 * A quiet "Learn more", used both at the end of a row description and in a
 * subsection header's action slot.
 *
 * A bare `Link` rather than `Button asChild`, deliberately. `Button`'s base
 * class is `flex`, so wrapping this one would turn it into a block inside the
 * description paragraph — "…how to run this workspace." would sit on one line
 * and "Learn more" would drop to its own. An underline is also the correct
 * affordance here: this is a link inside prose, not a control.
 *
 * `text-xs` is set rather than inherited so it matches the row descriptions it
 * appears in and stays quiet in the header slot, where nothing else sets a size.
 */
function DocsLink({ href, children = 'Learn more' }: { href: string; children?: ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground decoration-muted-foreground/40 hover:decoration-foreground text-xs whitespace-nowrap underline underline-offset-2 transition-colors"
    >
      {children}
    </Link>
  );
}

/**
 * One copyable line — a command to paste into a terminal, or an address.
 *
 * **It has no border and no background of its own.** It used to be a
 * `rounded-md` bordered box, which put a rounded surface inside the rounded
 * panel that held it — the nested rounding the design system bans, and the
 * reason the local-setup section read as cluttered: an outer panel inset,
 * plus a step inset, plus a box inset, for a single line of text. The line now
 * sits directly on its container and earns its affordance from the monospace
 * face, the `$`, and the copy button — with a hover tint as the only surface,
 * so nothing is drawn until the pointer says it matters.
 *
 * `kind="command"` prefixes a non-selectable `$`. It is not decoration: it is
 * the difference between a user pasting `kortix env pull` and pasting a line
 * they think is prose. The marker is `aria-hidden` and outside the `<code>`, so
 * copying still yields the bare command.
 */
function CommandLine({
  value,
  label,
  kind = 'command',
}: {
  value: string;
  label: string;
  kind?: 'command' | 'address';
}) {
  return (
    <div className="bg-muted group/command-line -mx-2 flex min-w-0 items-center gap-2 rounded-sm px-3 py-1.5 transition-colors">
      <code className="text-foreground scrollbar-hide min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap">
        {value}
      </code>
      <span className="shrink-0 opacity-0 transition-opacity duration-200 group-hover/command-line:opacity-100">
        <CopyButton code={value} size="sm" />
      </span>
    </div>
  );
}

const TONE_DOT: Record<ConnectionTone, string> = {
  connected: 'bg-kortix-green',
  attention: 'bg-kortix-orange',
  unknown: 'bg-muted-foreground/40',
};

/** Status as a dot plus a word. A `Badge` would announce itself louder than the
 *  repository name it describes; a dot is read as a state, not as a label. */
function StatusValue({ status }: { status: string | null | undefined }) {
  const { tone, label } = connectionStatusLabel(status);
  return (
    <span className="flex items-center gap-2 text-sm">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span className="text-foreground">{label}</span>
    </span>
  );
}

/**
 * What the project's OWN `repo_url` says about its repository, for projects
 * that have no `project_git_connections` row.
 *
 * A connection row is not the only way a project knows where its code lives:
 * `KortixProject.repo_url` is a required column, and a project can carry one
 * without ever having a connection row created for it. The pane used to read
 * the connection only, so those projects rendered "Not linked yet" and offered
 * no way to reach a repository that was sitting in the project record — the
 * regression this restores. `settings-view.tsx` on `main` linked straight off
 * `project.repo_url` and did not consult a connection at all.
 *
 * Returns `null` for an address this cannot place, so an unrecognized host
 * stays plain text instead of becoming a guessed URL. Both the SSH form
 * (`git@github.com:acme/project.git`) and the HTTPS form resolve, because
 * `main` linked both.
 */
export function projectRepoFallback(
  repoUrl: string | null | undefined,
): { provider: 'github' | 'gitlab'; label: string; webUrl: string | null } | null {
  const raw = repoUrl?.trim();
  if (!raw) return null;

  const segments = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\/+$/, '')
    .split(/[:/]/)
    .filter(Boolean);
  if (segments.length < 3) return null;

  const host = segments[0]!.toLowerCase();
  const provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : null;
  if (!provider) return null;

  const owner = segments[segments.length - 2]!;
  const name = segments[segments.length - 1]!.replace(/\.git$/i, '');
  return {
    provider,
    label: `${owner}/${name}`,
    webUrl: repositoryWebUrl(provider, `https://${host}/${owner}/${name}`),
  };
}

/**
 * The repository the project points at.
 *
 * The connection row stays the source of truth whenever there is one — it is
 * the only thing that knows the owner/name split the backend resolved. The
 * project's own `repo_url` is read only in its absence, and "Not linked yet" is
 * reserved for the one state where it is true: no connection AND no address.
 */
export function RepositoryValue({
  connection,
  repoUrl,
}: {
  connection: ProjectGitConnection | null | undefined;
  repoUrl?: string | null;
}) {
  const fallback = connection ? null : projectRepoFallback(repoUrl);
  const name =
    connection?.repo_owner && connection.repo_name
      ? `${connection.repo_owner}/${connection.repo_name}`
      : connection?.repo_url || fallback?.label || repoUrl?.trim() || 'Not linked yet';
  const webUrl = connection?.repo_url
    ? repositoryWebUrl(connection.provider, connection.repo_url)
    : (fallback?.webUrl ?? null);
  const provider = connection?.provider ?? fallback?.provider;
  const Glyph = provider === 'github' ? Github : GitFork;

  if (webUrl?.startsWith('http')) {
    return (
      <Button variant="ghost" size="sm" className="-mr-2 max-w-[15rem] gap-1.5" asChild>
        <a href={webUrl} target="_blank" rel="noopener noreferrer">
          <Glyph className="size-4 shrink-0" />
          <span className="truncate font-normal">{name}</span>
          <ExternalLink className="size-3.5 shrink-0 opacity-60" />
        </a>
      </Button>
    );
  }

  return (
    <span className="text-foreground flex max-w-[15rem] items-center gap-1.5 text-sm">
      <Glyph className="size-4 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}

/**
 * The repository group: what it is connected to, whether that connection works,
 * and the two settings that change how Kortix uses it.
 *
 * These were two separate sections before — a read-only "Repository" summary
 * box and a "Repository settings" panel — which is what produced the duplicate
 * headings. They are one group now because they are one subject: a person
 * checking which repo is linked and a person changing the base branch are on
 * the same errand, and the answer to "is it connected" belongs beside the
 * controls that stop working when it isn't.
 *
 * No `SettingsSubsectionHeader` above it, deliberately — the pane title right
 * above already reads "Repositories", and labelling the first group "Repository"
 * is the exact duplication this rewrite removes. Same reasoning as
 * `general-tab.tsx`'s first group.
 */
function RepositoryGroup({
  project,
  connection,
  canManage,
}: {
  project: KortixProject;
  connection: ProjectGitConnection | null | undefined;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
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
  const repositoryProvider =
    connection?.provider ??
    (connection ? undefined : projectRepoFallback(project.repo_url)?.provider);

  return (
    <section className="space-y-3">
      {connection?.last_error_message ? (
        <InfoBanner tone="warning" icon={WarningIcon} title="Kortix can't reach this repository">
          {connection.last_error_message}
        </InfoBanner>
      ) : null}

      <SettingsRowGroup>
        {/* The description names the provider the row's value came from. With no
            connection row that fact still exists — it is readable off the
            project's own address — so this reads the same fallback the value
            does rather than saying a flat "Hosted on Git." beside a GitHub
            link. */}
        <SettingsRow label="Repository" description={providerSentence(repositoryProvider)}>
          <RepositoryValue connection={connection} repoUrl={project.repo_url} />
        </SettingsRow>

        <SettingsRow label="Status">
          <StatusValue status={connection?.status} />
        </SettingsRow>

        <SettingsRow
          label="Base branch"
          description="New sessions and change requests start from this branch."
        >
          {saving ? <SaveStatus /> : null}
          <Select
            value={defaultBranch}
            onValueChange={setDefaultBranch}
            disabled={!canManage || isPending}
          >
            <SelectTrigger aria-label="Base branch" className="h-8 w-44 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {branchNames.map((branch) => (
                <SelectItem key={branch} value={branch} className="font-mono text-xs">
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          label="Manifest file"
          description={
            <>
              The file in your repository that tells Kortix how to run this workspace.{' '}
              <DocsLink href={DOCS_MANIFEST} />
            </>
          }
        >
          <Input
            id="manifest-path"
            aria-label="Manifest file"
            value={manifestPath}
            onChange={(e) => setManifestPath(e.target.value)}
            disabled={!canManage || isPending}
            className="h-8 w-44 font-mono text-xs"
          />
        </SettingsRow>
      </SettingsRowGroup>
    </section>
  );
}

/**
 * One numbered step — a row in the steps group, not a card.
 *
 * The badge is `size-5`, which is exactly `text-sm`'s 20px line box, so it
 * aligns with the first line of the title by layout rather than by a nudge.
 *
 * The connector line that used to join the badges is gone with the panel that
 * held them: the group's hairline dividers already say "these are consecutive
 * steps", so a second sequencing device was redundant ink.
 */
function Step({
  index,
  title,
  hint,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs text-pretty">{hint}</p>
        </div>
        <div className="space-y-0.5">{children}</div>
      </div>
    </li>
  );
}

/**
 * The three commands that put this workspace on someone's laptop, in order.
 *
 * Written out as literal JSX rather than mapped over a data array on purpose:
 * `git-view.test.ts` asserts `label="Install command"` appears before
 * `label="Clone command"` in this file's source, which is how the
 * install-before-clone order is pinned in a codebase with no DOM test harness.
 * A `.map()` over `{ label: 'Install command' }` object literals would not
 * match that assertion and would silently un-pin the order.
 */
function LocalSetup({ projectId }: { projectId: string }) {
  const installCommand = useDeploymentCliInstallCommand(getEnv().VERSION);

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title="Work on this locally"
        description="Put a copy of this workspace on your own computer and edit it in your own editor."
        action={<DocsLink href={DOCS_CLI} />}
      />
      {/* Carries `SettingsRowGroup`'s exact classes on an `<ol>` rather than
          using the component, which renders a `div`. These are numbered steps,
          so the ordered-list semantics are the point — a screen reader should
          announce "list, 3 items", and `<li>` needs a real list parent.
          Everything visual matches the groups above it, so the pane still reads
          as one system. */}
      <ol className="bg-popover divide-border divide-y overflow-hidden rounded-md border">
        <Step
          index={1}
          title="Install the Kortix command line"
          hint="A one-time setup on macOS or Linux. Skip this if you already have it."
        >
          <CommandLine value={installCommand} label="Install command" />
        </Step>
        <Step
          index={2}
          title="Copy the workspace to your computer"
          hint="Downloads the code into a new folder and links that folder to this workspace."
        >
          <CommandLine value={`kortix projects clone ${projectId}`} label="Clone command" />
        </Step>
        <Step
          index={3}
          title="Finish setup inside the new folder"
          hint="Writes the local config, then fetches this workspace's secrets so the code can run."
        >
          <CommandLine value="kortix init --force" label="Setup command" />
          <CommandLine value="kortix env pull" label="Secrets command" />
        </Step>
      </ol>
    </section>
  );
}

/**
 * Advanced escape hatch, folded away by default.
 *
 * This is the old "Kortix proxy origin" section. It is behind a disclosure now
 * because the numbered steps above are the supported path and this is the
 * alternative for people who already have a Git workflow — surfacing both at
 * equal weight was most of what made the pane feel like a config dump. The copy
 * leads with what you can do (`git clone`) and the thing that is genuinely
 * unusual about it (no token to create or store), not with how Kortix resolves
 * the credential.
 */
function OwnGitClient({ project }: { project: ProjectWithOrigin }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      {/* `variant="outline"` already supplies `w-full rounded-md border` — only
          the surface fill and the corner clip are added here. `overflow-hidden`
          is what lets the trigger square off its bottom corners while open
          without a hairline poking past the rounded container. */}
      <Disclosure
        variant="outline"
        className="bg-popover overflow-hidden"
        open={open}
        onOpenChange={setOpen}
      >
        <DisclosureTrigger variant="outline">
          {/* `h-auto` and `whitespace-normal` both override `Button` defaults
              that are wrong for a two-line trigger: `size="default"` pins `h-9`
              (which a title + description overflows) and the base class carries
              `whitespace-nowrap` (which stops the description wrapping at all).
              `items-start` keeps the caret on the title's line rather than
              floating to the vertical centre of a wrapped block. */}
          <Button
            variant="popover"
            className="hover:bg-muted/50 flex h-auto w-full items-start justify-between gap-3 rounded-none px-4 py-3 text-left whitespace-normal"
          >
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="text-foreground block text-sm font-medium">
                Use your own Git client
              </span>
              <span className="text-muted-foreground block text-xs font-normal text-pretty">
                Clone with plain <code className="font-mono">git</code> instead of the Kortix
                command line.
              </span>
            </span>
            <CaretDownIcon
              className={cn(
                'text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </Button>
        </DisclosureTrigger>
        <DisclosureContent variant="outline" contentClassName="border-border border-t">
          <div className="space-y-2 px-4 py-3.5">
            <p className="text-muted-foreground text-xs text-pretty">
              Clone from this address with any Git client. When git asks, enter any username and a
              Kortix API key as the password — the Kortix command line does this for you through its
              credential helper, plain <code className="font-mono">git</code> does not.
            </p>
            <CommandLine value={gitCloneUrl(project)} label="Clone address" kind="address" />
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}

/**
 * "People with access" — always rendered for someone who may manage members,
 * with a body that depends on who actually controls the repository.
 *
 * The section used to be gated on `managed && canEdit` and render NOTHING
 * otherwise, which produced the support question this replaces: a workspace
 * owner on a BYO repo saw the Git repo panel with no access row under it and
 * no way to find out why. Hiding a control does not answer "where do I add
 * someone" — it just moves the question into a support thread.
 *
 * Two things the old gate got wrong, both fixed here:
 *
 * 1. It read `project.write`. The route asserts `project.members.manage`
 *    (`apps/api/src/projects/routes/r1.ts`, "Inviting a git collaborator
 *    grants a human standing access to the repo — membership-tier, not plain
 *    write"). A custom role holding write-but-not-members.manage saw the form
 *    and got a 403 on submit; the reverse role saw nothing though the API
 *    would have accepted it. The gate now asks for the leaf the route asks
 *    for.
 * 2. A non-managed repository disappeared instead of explaining itself.
 */
function RepoAccessSection({
  projectId,
  connection,
  managed,
  canManageMembers,
}: {
  projectId: string;
  connection: ProjectGitConnection | null | undefined;
  managed: boolean;
  canManageMembers: boolean;
}) {
  // Still gated on the capability — someone who cannot grant repository access
  // has no use for either the form or an explanation of where to grant it.
  if (!canManageMembers) return null;

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title="People with access"
        description={
          managed
            ? 'Invite someone by their GitHub username. GitHub emails them an invite to accept.'
            : 'Who can read and write this workspace’s repository.'
        }
      />
      {managed ? (
        <RepoCollaboratorInvite projectId={projectId} />
      ) : (
        <ExternallyManagedRepoAccess connection={connection} />
      )}
    </section>
  );
}

/**
 * The body for a repository Kortix does not own.
 *
 * Collaborator invites go through the managed org's admin credential
 * (`managedAdminAuth`, `apps/api/src/projects/git-backends/github.ts`), which
 * only has repo-admin scope on repositories Kortix created — so for a BYO repo
 * there is nothing Kortix could do here even with the user's permission. The
 * honest answer is where to go instead, and for GitHub that is a real link
 * rather than a description of one.
 *
 * Providers other than GitHub reach this too: a workspace provisioned while
 * `MANAGED_GIT_PROVIDER=code-storage` was the default (between #5063 and its
 * retirement in #6796) is a MANAGED repo whose backend has no
 * `inviteCollaborator` at all. Naming the provider is what tells those users
 * they are not looking at a broken GitHub connection.
 */
function ExternallyManagedRepoAccess({
  connection,
}: {
  connection: ProjectGitConnection | null | undefined;
}) {
  const provider = connection?.provider;
  // GitHub only. `repositoryWebUrl` also answers for GitLab, but the deep link
  // below is `/settings/access`, which is GitHub's path — GitLab's is
  // `/-/project_members`. A link that 404s is worse than no link, so the button
  // is scoped to the one host whose path is known here.
  const webUrl =
    provider === 'github' && connection?.repo_url
      ? repositoryWebUrl(provider, connection.repo_url)
      : null;

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <p className="text-muted-foreground text-xs text-pretty">
        {provider === 'github'
          ? 'Kortix did not create this repository, so it cannot add collaborators to it. Manage access from the repository settings on GitHub.'
          : `This workspace’s repository is hosted on ${providerLabel(provider)}, which does not support collaborator invites from Kortix. Manage access where the repository lives.`}
      </p>
      {webUrl ? (
        <Button asChild variant="outline" size="sm" className="mt-3 gap-1.5">
          <a href={`${webUrl}/settings/access`} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3.5 shrink-0" />
            Manage on GitHub
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function RepoCollaboratorInvite({ projectId }: { projectId: string }) {
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
    <>
      {/* `p-3` and `rounded-sm` controls inside a `rounded-md` panel: concentric
          radius, and no third level of inset. The `Field`/`FieldGroup` wrappers
          this form used to carry are gone — they exist to structure a label and
          a description, and there is neither here; each control names itself
          with `aria-label` and a placeholder. */}
      <div className="bg-popover rounded-md border p-3">
        <form
          onSubmit={submit}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center"
        >
          <div className="relative min-w-0">
            <GithubIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              id="repo-collaborator-username"
              aria-label="GitHub username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="GitHub username"
              // NOT `variant="popover"`. That variant is `bg-popover`, the same
              // fill as the panel around it, so the input dissolved into its own
              // container. The default `bg-input` is what makes it read as
              // something you can type in. Same call `general-tab.tsx` made.
              size="xs"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="rounded-sm pl-8"
            />
          </div>

          <Select value={permission} onValueChange={(v) => setPermission(v as 'read' | 'write')}>
            <SelectTrigger
              id="repo-collaborator-permission"
              aria-label="Access level"
              className="h-8 w-full rounded-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="write">Can edit</SelectItem>
              <SelectItem value="read">Can view</SelectItem>
            </SelectContent>
          </Select>

          <Button
            type="submit"
            size="sm"
            className="w-full shrink-0 rounded-sm transition-transform active:scale-[0.96] sm:w-auto"
            disabled={!username.trim() || inviteMutation.isPending}
          >
            {inviteMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            Invite
          </Button>
        </form>
      </div>
    </>
  );
}

export function GitView({ projectId }: { projectId: string }) {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  // `detail.data.project` is a full `KortixProject`, so `RepositoryGroup` reads
  // its `default_branch`/`manifest_path` from this SAME query rather than firing
  // a second project fetch.
  const project = detail.data?.project;
  // Two leaves, one roundtrip. This used to be a single `project.write` probe
  // reused for BOTH the repository settings and the collaborator invite — but
  // the invite route asserts `project.members.manage`
  // (`apps/api/src/projects/routes/r1.ts`), a strictly different leaf, so the
  // one probe was answering a question the server never asked. `GIT_VIEW_ACTIONS`
  // is module-level and stable because the action-list identity is part of the
  // SDK query key.
  const cans = useProjectCans(projectId, GIT_VIEW_ACTIONS);
  const canEdit = cans[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
  const canManageMembers = cans[PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE]?.allowed === true;
  // Managed = Kortix created this repository, so the managed-org admin
  // credential has repo-admin scope on it. False for a BYO repo and for a
  // repository on any provider other than GitHub.
  // The connection row is the truth since repositories moved out of
  // `metadata.git` (`project_git_connections.managed`); the metadata check
  // is the fallback for a server that predates the field. Reading metadata
  // alone said "Kortix did not create this repository" for every managed
  // repo — the block only holds `seed` and `fast_boot` now.
  const managed =
    detail.data?.git_connection?.managed ?? (project ? isManagedGithubProject(project) : false);

  return (
    <div className="space-y-8">
      {/* No `SettingsTabHeader`/own width wrapper any more — Repositories
          merged INTO the General section as a "Git repo" subsection (Jay's
          call, 2026-08-17: "move the repository stuff into the general tab...
          put it under a git repo section"). `GeneralTabView` already supplies
          the shared `mx-auto w-full max-w-2xl` column and its own top-level
          heading; a second one here would be a duplicate, the same fix
          `snapshots-tab.tsx` got when Snapshots merged into Sandbox
          templates. */}
      {/* No subsection heading: this view is the Settings tab's own "Git repo"
          section since 2026-09-03, and the section pane already carries that
          title (`project-settings-page.tsx`). */}

      {detail.isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-44 rounded-md" />
          <Skeleton className="h-56 rounded-md" />
        </div>
      ) : null}

      {detail.isError ? (
        <ErrorState
          size="sm"
          title="Could not load this workspace's repository"
          description={(detail.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => detail.refetch()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : null}

      {project ? (
        <>
          <RepositoryGroup
            project={project}
            connection={detail.data?.git_connection}
            canManage={canEdit}
          />
          {/* The clone address right under the repository (Marko, 2026-09-03):
              it is the Kortix-signed address of THIS repo, so it belongs with
              the repo, not at the foot after who-can-access. */}
          <OwnGitClient project={project as ProjectWithOrigin} />
          {/* Who can reach the repo comes before how to work on it locally
              (Marko, 2026-09-03): access is the decision, the local setup is
              the how-to. */}
          <RepoAccessSection
            projectId={projectId}
            connection={detail.data?.git_connection}
            managed={managed}
            canManageMembers={canManageMembers}
          />
          <LocalSetup projectId={projectId} />
        </>
      ) : null}
    </div>
  );
}
