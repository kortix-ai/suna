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
import { MANAGED_GIT_BACKEND_KEY } from '@/components/iam/managed-git-notice';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { BranchPicker, RepositoryPicker } from '@/features/projects/modal/github-import-pickers';
import { plannedRepoPath, withRepositoryChoice } from '@/features/workspace/new/github-source';
import type {
  NewWorkspaceFormState,
  RepositorySource,
} from '@/features/workspace/new/new-workspace-form';
import {
  type RepositoryChoice,
  defaultRepositoryChoice,
  parseRepositoryChoice,
  repositoryChoices,
  selectedChoice,
} from '@/features/workspace/new/repository-options';
import { newWorkspaceReturnPath } from '@/features/workspace/new/source-param';
import { useDebounce } from '@/hooks/use-debounce';
import {
  gitHubInstallationUnreachable,
  githubInstallationLabel,
  rememberGitHubSetupReturn,
} from '@/lib/github-installations';
import { hubTarget } from '@/stores/account-panel-store';
import {
  getManagedGitBackend,
  listGitHubInstallations,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  listManagedGitRepositories,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The repository fields on `/new`.
 *
 * ## One list, connections first
 *
 * This used to be two controls: an abstract source (`Kortix managed`, `Create
 * in GitHub`, `Import from GitHub`) and — only after a GitHub source was
 * picked — a second select for WHICH GitHub account. The default was
 * `Kortix managed`, so an account that had gone to the trouble of connecting
 * GitHub was still offered the option that ignores it.
 *
 * Now there is one list (`repository-options.ts`): every connected GitHub
 * owner contributes "create a repository in it" and "import a repository from
 * it", in the API's order, and `Kortix managed` is a single option at the end.
 * The first entry is the default, so a connected account defaults to its
 * connection and an unconnected one defaults to `Kortix managed`.
 *
 * ## Nothing here prints a GitHub error verbatim
 *
 * A repository listing whose installation GitHub no longer resolves used to
 * spin through three silent retries and then print GitHub's own sentence —
 * `/app/installations/148404669/access_tokens failed (404): Not Found`. Every
 * query below is `retry: false`, and the two failures that have an action
 * attached (`github_installation_unreachable`, managed git not configured) say
 * what to do instead of what the upstream returned.
 */

/**
 * Shown when the account has no GitHub App installation to act through.
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
  const t = useTranslations('newWorkspace');
  const href = accountId
    ? `/github/setup?account_id=${encodeURIComponent(accountId)}`
    : '/github/setup';

  return (
    <p className="text-muted-foreground text-xs">
      {t('repository.noGitHubAccount')}{' '}
      <Link
        href={href}
        onClick={() => rememberGitHubSetupReturn(newWorkspaceReturnPath(source))}
        className="text-foreground underline underline-offset-2"
      >
        {t('repository.connectGitHub')}
      </Link>{' '}
      {t('repository.connectGitHubSuffix')}
    </p>
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
  const t = useTranslations('newWorkspace');

  // Same cache key the account hub's Git tab and `connected-tab.tsx` use, so
  // arriving here after connecting an account on either surface hits a warm
  // cache instead of refetching.
  const installationsQuery = useQuery({
    queryKey: ['github-installations', accountId],
    queryFn: () => listGitHubInstallations(accountId as string),
    enabled: Boolean(accountId),
    staleTime: 60_000,
    retry: false,
  });

  // Whether this instance can create a managed repository at all. Any
  // authenticated user may read it; the platform-admin status endpoint must
  // never be called from here.
  const managedQuery = useQuery({
    queryKey: MANAGED_GIT_BACKEND_KEY,
    queryFn: () => getManagedGitBackend(),
    staleTime: 60_000,
    retry: false,
  });

  // Account connections, as the API returns them: oldest first, and account
  // connections ONLY. The synthetic managed-git entry that used to be injected
  // into this list is gone — on 2026-08-29 picking it listed the managed
  // owner's ENTIRE repository set, every customer's project repo, to a Kortix
  // admin, one click from importing one. The instance backend has its own
  // control below (`ManagedImportField`).
  const connections = useMemo(
    () => installationsQuery.data?.installations ?? [],
    [installationsQuery.data],
  );
  const managedConfigured = managedQuery.data?.configured ?? false;
  const choices = useMemo(
    () => repositoryChoices(connections, managedConfigured),
    [connections, managedConfigured],
  );
  const optionsLoading = installationsQuery.isLoading || managedQuery.isLoading;
  const selected = selectedChoice(choices, state.source, state.installationId);

  // Seed the default ONCE, when the options land. An effect, not a render-time
  // derivation: the submit gate reads `state.source`/`state.installationId`, so
  // a value that existed only as a local would show a filled-in Select above a
  // disabled Create button.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || optionsLoading) return;
    seeded.current = true;
    const fallback = defaultRepositoryChoice(choices);
    // `managed` is already the initial state; only a connection is a change.
    if (!fallback || fallback.kind === 'managed') return;
    onChange(withRepositoryChoice(state, fallback));
    // Fires on the arrival of the options, not on every keystroke in the name
    // field, and `seeded` makes it idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsLoading]);

  function choiceLabel(choice: RepositoryChoice): string {
    const owner = githubInstallationLabel(choice.ownerLogin);
    if (choice.kind === 'github-create') return t('repository.createInOwner', { owner });
    if (choice.kind === 'github-import') return t('repository.importFromOwner', { owner });
    return t('repository.sources.managed.label');
  }

  function choiceDescription(choice: RepositoryChoice): string {
    if (choice.kind === 'github-create') return t('repository.sources.githubCreate.description');
    if (choice.kind === 'github-import') return t('repository.sources.githubImport.description');
    return t('repository.sources.managed.description');
  }

  return (
    <>
      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-source">{t('repository.label')}</Label>
        {optionsLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {t('repository.loadingOptions')}
          </p>
        ) : choices.length === 0 ? (
          // No connection AND no managed git: the only honest thing left is to
          // say managed git is unavailable and offer the connect route.
          <>
            <p className="text-muted-foreground text-xs">{t('repository.managedUnavailable')}</p>
            <ConnectGitHubNote accountId={accountId} source={state.source} />
          </>
        ) : (
          <>
            <Select
              value={selected?.value ?? ''}
              onValueChange={(value) => {
                const choice = parseRepositoryChoice(choices, value);
                if (choice) onChange(withRepositoryChoice(state, choice));
              }}
            >
              <SelectTrigger id="workspace-source" className="w-full" size="md">
                <SelectValue placeholder={t('repository.selectOption')} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choiceLabel(choice)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <p className="text-muted-foreground text-xs">{choiceDescription(selected)}</p>
            ) : null}
            {installationsQuery.isError ? (
              <p className="text-destructive text-xs">{t('repository.loadGitHubAccountsError')}</p>
            ) : null}
            {connections.length === 0 ? (
              <ConnectGitHubNote accountId={accountId} source={state.source} />
            ) : null}
          </>
        )}
        {selected?.kind === 'github-create' && plannedRepoPath(selected.ownerLogin, state.name) ? (
          // The workspace name is free text and a GitHub repository name is
          // not, so `repoSlugFromName` can change it noticeably. Showing the
          // result before the create is what stops that being a surprise
          // discovered in the repository list afterwards.
          <p className="text-muted-foreground text-xs">
            {t.rich('repository.createsPath', {
              path: () => (
                <span className="font-mono">{plannedRepoPath(selected.ownerLogin, state.name)}</span>
              ),
            })}
          </p>
        ) : null}
      </div>

      {selected?.kind === 'github-import' ? (
        <ImportRepositoryField state={state} accountId={accountId} onChange={onChange} />
      ) : null}

      {selected?.kind === 'managed' ? (
        <ManagedImportField state={state} onChange={onChange} />
      ) : null}

      {/* `create-repo` does not accept a default branch — it reads
          `repo.default_branch` off the repository GitHub just made
          (`apps/api/src/projects/routes/r2.ts`) — so the field is hidden for
          that source rather than collecting a value that would be dropped.
          Import gets a real branch list off the chosen repository; managed
          gets the free-text field, because the repo it names does not exist
          yet and so has no branches to list. */}
      {selected?.kind === 'github-create' ? null : selected?.kind === 'github-import' ? (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-branch">{t('repository.defaultBranch')}</Label>
          <ImportBranchField state={state} accountId={accountId} onChange={onChange} />
        </div>
      ) : (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-branch">{t('repository.defaultBranch')}</Label>
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
 * The repository list for `import a repository from <owner>`.
 *
 * `retry: false` is the fix for the report that opened this work: with the
 * default three retries a connection whose installation GitHub no longer
 * resolves spun for seconds with no bound and then printed GitHub's raw
 * sentence. One attempt, then a state that says what to do.
 */
function ImportRepositoryField({
  state,
  accountId,
  onChange,
}: {
  state: NewWorkspaceFormState;
  accountId: string | null;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  const t = useTranslations('newWorkspace');
  const [repoSearch, setRepoSearch] = useState('');
  // The repositories route takes `search` as a server-side filter, so every
  // keystroke would otherwise be a request. `RepositoryPicker` also filters
  // what it already holds client-side, so the debounce only delays WIDENING
  // the result set, never the responsiveness of the list in front of the user.
  const { debouncedValue: debouncedRepoSearch } = useDebounce(repoSearch, 300);

  const reposQuery = useQuery({
    queryKey: ['github-repositories', accountId, state.installationId, debouncedRepoSearch],
    queryFn: () =>
      listGitHubRepositories(accountId as string, state.installationId, {
        search: debouncedRepoSearch || undefined,
      }),
    enabled: Boolean(accountId && state.installationId),
    staleTime: 30_000,
    retry: false,
  });

  const repos = reposQuery.data?.repositories ?? [];
  const unreachable = gitHubInstallationUnreachable(reposQuery.error);

  return (
    <div className="flex flex-col space-y-3">
      <Label htmlFor="workspace-repository">{t('repository.repositoryLabel')}</Label>
      <RepositoryPicker
        value={state.repoFullName ?? ''}
        repos={repos}
        loading={reposQuery.isFetching}
        disabled={!state.installationId || Boolean(unreachable)}
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
          {unreachable ? t('repository.installationUnreachable') : t('repository.loadRepositoriesError')}{' '}
          {unreachable && accountId ? (
            <HubLink
              to={hubTarget(accountId, { tab: 'git' })}
              className="text-foreground underline underline-offset-2"
            >
              {t('repository.reconnect')}
            </HubLink>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Import an existing managed repository" — the self-host operator's way to
 * adopt a repository the managed-git owner already holds.
 *
 * It replaces the synthetic `pat` entry that used to appear in the GitHub
 * ACCOUNT list, where it read like one more customer connection and listed the
 * managed owner's entire repository set to anyone who picked it. This control
 * only exists when `GET /projects/git/backend/repositories` answers — the
 * route is operator-only and 403s for everyone else, which is a reason to hide
 * the control, not an error to report.
 */
function ManagedImportField({
  state,
  onChange,
}: {
  state: NewWorkspaceFormState;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  const t = useTranslations('newWorkspace');
  const [search, setSearch] = useState('');
  const { debouncedValue: debouncedSearch } = useDebounce(search, 300);

  const managedReposQuery = useQuery({
    queryKey: ['managed-git-repositories', debouncedSearch],
    queryFn: () => listManagedGitRepositories({ search: debouncedSearch || undefined }),
    staleTime: 30_000,
    retry: false,
  });

  if (!managedReposQuery.isSuccess) return null;
  const repos = managedReposQuery.data.repositories;

  return (
    <div className="flex flex-col space-y-3">
      <Label htmlFor="workspace-managed-repository">{t('repository.managedImportLabel')}</Label>
      <RepositoryPicker
        value={state.repoFullName ?? ''}
        repos={repos}
        loading={managedReposQuery.isFetching}
        disabled={false}
        onSearchChange={setSearch}
        onValueChange={(repoFullName) => {
          const repo = repos.find((candidate) => candidate.full_name === repoFullName);
          onChange({
            ...state,
            repoFullName,
            defaultBranch: repo?.default_branch || state.defaultBranch,
          });
        }}
      />
      <p className="text-muted-foreground text-xs">{t('repository.managedImportHint')}</p>
    </div>
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
    queryKey: ['github-repository-branches', accountId, state.installationId, state.repoFullName],
    queryFn: () =>
      listGitHubRepositoryBranches(
        accountId as string,
        state.installationId as string,
        state.repoFullName as string,
      ),
    enabled: Boolean(accountId && state.installationId && state.repoFullName),
    staleTime: 30_000,
    // Same bound as the repository list: the branch route answers the same 409
    // for an installation GitHub no longer resolves.
    retry: false,
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
