'use client';

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
import { BranchPicker, RepositoryPicker } from '@/features/projects/modal/github-import-pickers';
import {
  isGitHubSource,
  plannedRepoPath,
  withRepositorySource,
} from '@/features/workspace/new/github-source';
import type {
  NewWorkspaceFormState,
  RepositorySource,
} from '@/features/workspace/new/new-workspace-form';
import { newWorkspaceReturnPath } from '@/features/workspace/new/source-param';
import { useDebounce } from '@/hooks/use-debounce';
import { githubInstallationLabel, isGitHubAppInstallationId, rememberGitHubSetupReturn } from '@/lib/github-installations';
import {
  listGitHubInstallations,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Repository source is a disclosure, not a visible choice, because `managed`
 * is right for almost everyone and `projects.repo_url` being NOT NULL means
 * the decision cannot be skipped — only defaulted. Same call the old create
 * modal made (`project-create-modal.tsx:171`), kept collapsed by default here
 * so `/new` still opens as a single name field.
 *
 * Wording matches `project-create-modal.tsx:125-129` (`REPOSITORY_MODE_DESCRIPTIONS`)
 * so the two surfaces never diverge while both exist — "workspace" replaces
 * "project" in the managed line only, the other two already say neither word.
 */
const SOURCE_DESCRIPTIONS: Record<RepositorySource, string> = {
  managed: 'Kortix creates and manages a private repository for this workspace.',
  'github-create': 'Kortix creates a private repository in your GitHub account.',
  'github-import': 'Select an existing repository from your GitHub account.',
};

const SOURCE_LABELS: Record<RepositorySource, string> = {
  managed: 'Kortix managed',
  'github-create': 'Create in GitHub',
  'github-import': 'Import from GitHub',
};

/**
 * Shown when the account has no GitHub App installation to act through.
 *
 * `github-create` and `github-import` both need one — `POST
 * /projects/create-repo` and `POST /projects/link-repository` resolve their
 * credentials from it (`apps/api/src/projects/routes/r2.ts`), and answer 409
 * `Install the Kortix GitHub App…` when there is none. Sending the user to
 * `/github/setup` BEFORE they press Create is that 409 turned into a link.
 *
 * `rememberGitHubSetupReturn` is what makes it a round trip rather than a
 * one-way exit: the setup page reads that path back on completion
 * (`app/(auth)/github/setup/page.tsx`, `consumeGitHubSetupReturn`), so the
 * user lands back on `/new` with their chosen source intact
 * (`newWorkspaceReturnPath`). The typed name does not survive — a real
 * navigation, not a modal — which is why the source is carried in the URL and
 * not just assumed.
 *
 * Plain text in the existing field group, not an `InfoBanner`: that primitive
 * is itself a bordered `bg-popover` box and this note sits inside the page's
 * own field group, so it would read as a card inside a card.
 */
function ConnectGitHubNote({
  accountId,
  source,
}: {
  accountId: string | null;
  source: RepositorySource;
}) {
  const href = accountId
    ? `/github/setup?account_id=${encodeURIComponent(accountId)}`
    : '/github/setup';

  return (
    <p className="text-muted-foreground text-xs">
      No GitHub account is connected to this workspace's account yet.{' '}
      <Link
        href={href}
        onClick={() => rememberGitHubSetupReturn(newWorkspaceReturnPath(source))}
        className="text-foreground underline underline-offset-2"
      >
        Connect a GitHub account
      </Link>{' '}
      to use this option.
    </p>
  );
}

/**
 * The inputs the two GitHub sources need on top of the workspace name.
 *
 * Mounted only while a GitHub source is selected, so its three queries never
 * run for the `managed` default — which is the source almost every create
 * uses. Splitting it out of `AdvancedFields` is what keeps that true: hooks
 * cannot be called conditionally, so the queries have to live in a component
 * whose MOUNT is the condition.
 */
function GitHubSourceFields({
  state,
  accountId,
  onChange,
}: {
  state: NewWorkspaceFormState;
  accountId: string | null;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  const [repoSearch, setRepoSearch] = useState('');
  // The repositories route takes `search` as a server-side filter, so every
  // keystroke would otherwise be a request. `RepositoryPicker` also filters
  // what it already holds client-side, so the debounce only delays WIDENING
  // the result set, never the responsiveness of the list in front of the user.
  const { debouncedValue: debouncedRepoSearch } = useDebounce(repoSearch, 300);

  // Same cache key `accounts/[id]/page.tsx` and `connected-tab.tsx` already
  // use, so arriving here after connecting an account on either surface hits a
  // warm cache instead of refetching.
  const installationsQuery = useQuery({
    queryKey: ['github-installations', accountId],
    queryFn: () => listGitHubInstallations(accountId as string),
    enabled: Boolean(accountId),
    staleTime: 60_000,
  });

  const installations = installationsQuery.data?.installations ?? [];
  // `create-repo` needs org/repo-admin scope on a real GitHub App
  // installation. `serializeGitHubInstallations` can also return the synthetic
  // `pat` entry (the self-host "use a token" setup), which `link-repository`
  // accepts and `create-repo` does not — so it is offered for import only,
  // exactly as the old create modal split them.
  const selectable =
    state.source === 'github-create'
      ? installations.filter((installation) =>
          isGitHubAppInstallationId(installation.installation_id),
        )
      : installations;

  const installationId = state.installationId;
  const onlyInstallationId =
    selectable.length === 1 ? (selectable[0]?.installation_id ?? null) : null;

  // Seed the single installation rather than making the user "choose" from a
  // list of one. An effect, not a render-time derivation: `githubSourceReady`
  // (the submit gate) reads `state.installationId`, so a value that exists
  // only as a local variable would show a filled-in Select above a disabled
  // Create button.
  useEffect(() => {
    if (installationId || !onlyInstallationId) return;
    onChange({ ...state, installationId: onlyInstallationId });
    // `state`/`onChange` are excluded deliberately: this must fire on the
    // arrival of the single installation, not on every keystroke in the name
    // field, and the guard above already makes it idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installationId, onlyInstallationId]);

  const reposQuery = useQuery({
    queryKey: ['github-repositories', accountId, installationId, debouncedRepoSearch],
    queryFn: () =>
      listGitHubRepositories(accountId as string, installationId, {
        search: debouncedRepoSearch || undefined,
      }),
    enabled: Boolean(accountId && installationId) && state.source === 'github-import',
    staleTime: 30_000,
  });

  const repos = reposQuery.data?.repositories ?? [];
  const selectedOwner =
    selectable.find((installation) => installation.installation_id === installationId)
      ?.owner_login ?? null;
  const plannedPath = plannedRepoPath(selectedOwner, state.name);

  if (installationsQuery.isLoading) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loading className="size-3.5 shrink-0" />
        Loading GitHub accounts…
      </p>
    );
  }

  if (installationsQuery.isError) {
    return (
      <p className="text-destructive text-xs">
        Could not load GitHub accounts: {(installationsQuery.error as Error).message}
      </p>
    );
  }

  if (selectable.length === 0) {
    return <ConnectGitHubNote accountId={accountId} source={state.source} />;
  }

  return (
    <>
      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-installation">GitHub account</Label>
        <Select
          value={installationId ?? ''}
          onValueChange={(value) =>
            // The repository belongs to the installation, so changing the
            // installation invalidates it — clearing it here is what stops a
            // repo from one account being submitted against another.
            onChange({ ...state, installationId: value, repoFullName: null })
          }
        >
          <SelectTrigger id="workspace-installation" className="w-full" size="md">
            <SelectValue placeholder="Select a GitHub account" />
          </SelectTrigger>
          <SelectContent>
            {selectable.map((installation) => (
              <SelectItem
                key={installation.installation_id ?? ''}
                value={installation.installation_id ?? ''}
              >
                {githubInstallationLabel(
                  installation.installation_id,
                  installation.owner_login,
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state.source === 'github-create' && plannedPath ? (
          // The workspace name is free text and a GitHub repository name is
          // not, so `repoSlugFromName` can change it noticeably. Showing the
          // result before the create is what stops that being a surprise
          // discovered in the repository list afterwards.
          <p className="text-muted-foreground text-xs">
            Creates <span className="font-mono">{plannedPath}</span>
          </p>
        ) : null}
      </div>

      {state.source === 'github-import' ? (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-repository">Repository</Label>
          <RepositoryPicker
            value={state.repoFullName ?? ''}
            repos={repos}
            loading={reposQuery.isLoading || reposQuery.isFetching}
            disabled={!installationId}
            onSearchChange={setRepoSearch}
            onValueChange={(repoFullName) => {
              // Seed the branch from the repository's OWN default in the same
              // update. `link-repository` VALIDATES `default_branch` against
              // GitHub when it is sent (`resolveImportedDefaultBranch`), so
              // leaving the managed default of `main` here is a 400 for every
              // repository whose trunk is called anything else.
              const repo = repos.find((candidate) => candidate.full_name === repoFullName);
              onChange({
                ...state,
                repoFullName,
                defaultBranch: repo?.default_branch || state.defaultBranch,
              });
            }}
          />
          {reposQuery.isError ? (
            <p className="text-destructive text-xs">
              Could not load repositories: {(reposQuery.error as Error).message}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function AdvancedFields({
  state,
  accountId,
  onChange,
}: {
  state: NewWorkspaceFormState;
  /** The account the create targets — resolved by the page, which owns the
   *  "one account, nothing to pick" fallback. The GitHub queries below are
   *  account-scoped, so they cannot run on `state.accountId` alone: that is
   *  legitimately null for a single-account user. */
  accountId: string | null;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  return (
    <>
      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-source">Repository</Label>
        <Select
          value={state.source}
          onValueChange={(value) => onChange(withRepositorySource(state, value as RepositorySource))}
        >
          <SelectTrigger id="workspace-source" className="w-full" size="md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SOURCE_LABELS) as RepositorySource[]).map((source) => (
              <SelectItem key={source} value={source}>
                {SOURCE_LABELS[source]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{SOURCE_DESCRIPTIONS[state.source]}</p>
      </div>

      {isGitHubSource(state.source) ? (
        <GitHubSourceFields state={state} accountId={accountId} onChange={onChange} />
      ) : null}

      {/* `create-repo` does not accept a default branch — it reads
          `repo.default_branch` off the repository GitHub just made
          (`apps/api/src/projects/routes/r2.ts`) — so the field is hidden for
          that source rather than collecting a value that would be dropped.
          Import gets a real branch list off the chosen repository; managed
          gets the free-text field, because the repo it names does not exist
          yet and so has no branches to list. */}
      {state.source === 'github-create' ? null : state.source === 'github-import' ? (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-branch">Default branch</Label>
          <ImportBranchField state={state} accountId={accountId} onChange={onChange} />
        </div>
      ) : (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-branch">Default branch</Label>
          <Input
            id="workspace-branch"
            size="md"
            value={state.defaultBranch}
            onChange={(event) => onChange({ ...state, defaultBranch: event.target.value })}
            placeholder="main"
          />
        </div>
      )}
    </>
  );
}

/**
 * The branch control for `github-import` — a real list off the chosen
 * repository rather than a free-text box.
 *
 * A typed branch that does not exist is a 400 from `link-repository`
 * (`resolveImportedDefaultBranch`), discovered only on submit. Listing the
 * repository's actual branches removes that failure rather than reporting it.
 */
function ImportBranchField({
  state,
  accountId,
  onChange,
}: {
  state: NewWorkspaceFormState;
  accountId: string | null;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  const branchesQuery = useQuery({
    queryKey: [
      'github-repository-branches',
      accountId,
      state.installationId,
      state.repoFullName,
    ],
    queryFn: () =>
      listGitHubRepositoryBranches(
        accountId as string,
        state.installationId as string,
        state.repoFullName as string,
      ),
    enabled: Boolean(accountId && state.installationId && state.repoFullName),
    staleTime: 30_000,
  });

  return (
    <BranchPicker
      value={state.defaultBranch}
      branches={branchesQuery.data?.branches ?? []}
      loading={branchesQuery.isLoading}
      disabled={!state.repoFullName}
      onValueChange={(branch) => onChange({ ...state, defaultBranch: branch })}
    />
  );
}
