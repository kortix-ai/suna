'use client';

import { AddGitHubAccountDialog } from '@/components/iam/add-github-account-dialog';
import { MANAGED_GIT_BACKEND_KEY } from '@/components/iam/managed-git-notice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { BranchPicker, RepositoryPicker } from '@/features/projects/modal/github-import-pickers';
import { plannedRepoPath } from '@/features/workspace/new/github-source';
import type { NewWorkspaceFormState } from '@/features/workspace/new/new-workspace-form';
import {
  type GitAccountOption,
  type RepositoryAction,
  canCreateRepository,
  defaultGitAccount,
  gitAccountOptions,
  parseGitAccount,
  repositoryAction,
  selectedGitAccount,
  withGitAccount,
  withRepositoryAction,
} from '@/features/workspace/new/repository-options';
import { newWorkspaceReturnPath } from '@/features/workspace/new/source-param';
import { useDebounce } from '@/hooks/use-debounce';
import {
  gitHubInstallationUnreachable,
  githubInstallationLabel,
  githubOwnerKind,
} from '@/lib/github-installations';
import { hubTarget } from '@/stores/account-panel-store';
import {
  getManagedGitBackend,
  listGitHubInstallations,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  listManagedGitRepositories,
} from '@kortix/sdk';
import { GithubLogoIcon as Github, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The repository fields on `/new`: a git account manager, then the action.
 *
 * ## Whose account, then what to do there
 *
 * A project's repository lives under exactly one git owner, so the first
 * control is **Git account** — every GitHub personal account or organization
 * this Kortix account has connected, then `Kortix managed` (the instance's
 * own backend) as one option at the end, then "Add a GitHub account…", which
 * opens the same dialog the account Git tab uses (`AddGitHubAccountDialog`).
 * Under a GitHub owner a second control picks the action: create a new
 * repository, or import one that exists. `Kortix managed` has no action.
 *
 * This replaced one flat list that multiplied owners by actions ("Create a
 * repository in X / Import a repository from X / …"): with two owners it was
 * five rows that read as a repository menu, and the Kortix ACCOUNT the
 * project would land in sat in the far corner of the page (reported on dev,
 * 2026-09-17). The first git account is the default, so a connected account
 * defaults to its connection and an unconnected one to `Kortix managed`.
 *
 * ## Default branch only where it means something
 *
 * `create-repo` does not accept a default branch — it reads
 * `repo.default_branch` off the repository GitHub just made — and a managed
 * repository is created on `main` by the server. So the field appears only
 * for an IMPORT (a real branch list off the chosen repository), and for the
 * operator-only managed import once a repository is picked.
 *
 * ## Nothing here prints a GitHub error verbatim
 *
 * Every query below is `retry: false`, and the two failures that have an
 * action attached (`github_installation_unreachable`, managed git not
 * configured) say what to do instead of what the upstream returned.
 */

/** The `<Select>` value that opens the add-account dialog instead of picking. */
const ADD_ACCOUNT_VALUE = '__add_github_account__';

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
  const [addOpen, setAddOpen] = useState(false);

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
  // connections ONLY. The instance backend has its own row (`managed`) and its
  // own operator-only import control below (`ManagedImportField`).
  const connections = useMemo(
    () => installationsQuery.data?.installations ?? [],
    [installationsQuery.data],
  );
  const installUrl = installationsQuery.data?.install_url ?? null;
  const managedConfigured = managedQuery.data?.configured ?? false;
  const options = useMemo(
    () => gitAccountOptions(connections, managedConfigured),
    [connections, managedConfigured],
  );
  const optionsLoading = installationsQuery.isLoading || managedQuery.isLoading;
  const selected = selectedGitAccount(options, state);
  const action = repositoryAction(state);

  // Seed the default ONCE, when the options land. An effect, not a render-time
  // derivation: the submit gate reads `state.source`/`state.installationId`, so
  // a value that existed only as a local would show a filled-in Select above a
  // disabled Create button.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || optionsLoading) return;
    seeded.current = true;
    const fallback = defaultGitAccount(options);
    // `managed` is already the initial state; only a connection is a change.
    if (!fallback || fallback.kind === 'managed') return;
    onChange(withGitAccount(state, fallback));
    // Fires on the arrival of the options, not on every keystroke in the name
    // field, and `seeded` makes it idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsLoading]);

  // A personal account cannot take a new repository (`canCreateRepository`).
  // `withGitAccount` already lands such a pick on import; this covers a state
  // that reached `create` another way, such as a `?source=` return path.
  const canCreate = selected === null || canCreateRepository(selected);
  const createBlocked = !canCreate && action === 'create';
  useEffect(() => {
    if (createBlocked) onChange(withRepositoryAction(state, 'import'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createBlocked]);

  function ownerTypeLabel(option: GitAccountOption): string | null {
    if (option.kind !== 'github') return null;
    const kind = githubOwnerKind(option.ownerType);
    if (kind === 'org') return t('repository.ownerTypeOrg');
    if (kind === 'personal') return t('repository.ownerTypePersonal');
    return null;
  }

  const addAccountDialog = accountId ? (
    <AddGitHubAccountDialog
      open={addOpen}
      onOpenChange={setAddOpen}
      accountId={accountId}
      installUrl={installUrl}
      // Round trip: the setup page reads this path back on completion, so
      // the user lands on `/new` with the same source AND the same account.
      returnPath={newWorkspaceReturnPath(state.source, accountId)}
    />
  ) : null;

  return (
    <>
      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-source">{t('repository.gitAccountLabel')}</Label>
        {optionsLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {t('repository.loadingOptions')}
          </p>
        ) : options.length === 0 ? (
          // No connection AND no managed git: the only honest thing left is to
          // say managed git is unavailable and offer to add a GitHub account.
          <>
            <p className="text-muted-foreground text-xs">{t('repository.managedUnavailable')}</p>
            {accountId ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit gap-1.5"
                onClick={() => setAddOpen(true)}
              >
                <Github className="size-4" />
                {t('repository.addGitHubAccount')}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Select
              value={selected?.value ?? ''}
              onValueChange={(value) => {
                // The last row is an action, not a choice: it opens the dialog
                // and leaves the picked account exactly as it was.
                if (value === ADD_ACCOUNT_VALUE) {
                  setAddOpen(true);
                  return;
                }
                const option = parseGitAccount(options, value);
                if (option) onChange(withGitAccount(state, option));
              }}
            >
              <SelectTrigger id="workspace-source" className="w-full" size="md">
                <SelectValue placeholder={t('repository.selectGitAccount')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => {
                  const typeLabel = ownerTypeLabel(option);
                  return (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-baseline gap-2">
                        <span>
                          {option.kind === 'managed'
                            ? t('repository.sources.managed.label')
                            : githubInstallationLabel(option.ownerLogin)}
                        </span>
                        {typeLabel ? (
                          <span className="text-muted-foreground text-xs">{typeLabel}</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
                {accountId ? (
                  <>
                    <SelectSeparator />
                    <SelectItem value={ADD_ACCOUNT_VALUE}>
                      <span className="flex items-center gap-2">
                        <PlusIcon className="size-3.5" />
                        {t('repository.addGitHubAccount')}
                      </span>
                    </SelectItem>
                  </>
                ) : null}
              </SelectContent>
            </Select>
            {selected?.kind === 'managed' ? (
              <p className="text-muted-foreground text-xs">
                {t('repository.sources.managed.description')}
              </p>
            ) : null}
            {installationsQuery.isError ? (
              <p className="text-destructive text-xs">{t('repository.loadGitHubAccountsError')}</p>
            ) : null}
          </>
        )}
      </div>

      {selected?.kind === 'github' ? (
        <div className="flex flex-col space-y-3">
          <Label htmlFor="workspace-action">{t('repository.label')}</Label>
          {/* One value, two exclusive actions: the tabs primitive is the
              segmented control the design system already ships. */}
          <Tabs
            id="workspace-action"
            value={action}
            onValueChange={(value) => onChange(withRepositoryAction(state, value as RepositoryAction))}
          >
            <TabsList className="w-full">
              <TabsTrigger value="create" size="sm" className="flex-1" disabled={!canCreate}>
                {t('repository.actionCreate')}
              </TabsTrigger>
              <TabsTrigger value="import" size="sm" className="flex-1">
                {t('repository.actionImport')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!canCreate ? (
            <p className="text-muted-foreground text-xs">
              {t('repository.createPersonalUnsupported')}
            </p>
          ) : null}
          {action === 'create' ? (
            <p className="text-muted-foreground text-xs">
              {plannedRepoPath(selected.ownerLogin, state.name)
                ? // The workspace name is free text and a GitHub repository
                  // name is not, so `repoSlugFromName` can change it
                  // noticeably. Showing the result before the create is what
                  // stops that being a surprise discovered in the repository
                  // list afterwards.
                  t.rich('repository.createsPath', {
                    path: () => (
                      <span className="font-mono">
                        {plannedRepoPath(selected.ownerLogin, state.name)}
                      </span>
                    ),
                  })
                : t('repository.sources.githubCreate.description')}
            </p>
          ) : null}
        </div>
      ) : null}

      {selected?.kind === 'github' && action === 'import' ? (
        <>
          <ImportRepositoryField state={state} accountId={accountId} onChange={onChange} />
          <div className="flex flex-col space-y-3">
            <Label htmlFor="workspace-branch">{t('repository.defaultBranch')}</Label>
            <ImportBranchField state={state} accountId={accountId} onChange={onChange} />
          </div>
        </>
      ) : null}

      {selected?.kind === 'managed' ? (
        <>
          <ManagedImportField state={state} onChange={onChange} />
          {/* A managed repository the server creates has no branch to choose —
              it is born on `main`. Only an operator importing an EXISTING
              managed repository names one, seeded from that repository. */}
          {state.repoFullName ? (
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
          ) : null}
        </>
      ) : null}

      {addAccountDialog}
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
