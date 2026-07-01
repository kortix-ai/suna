'use client';

import { useTranslations } from 'next-intl';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { LegacyMachineCard } from '@/components/projects/legacy-machine-card';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { SunaMigrationBanner } from '@/components/projects/suna-migration-banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { UpgradeButton } from '@/features/billing/upgrade-button';
import { Icon } from '@/features/icon/icon';
import { AppHeader } from '@/features/layout/app-header';
import { ProjectCreateModal } from '@/features/projects/modal/project-create-modal';
import { RenameProjectDialog } from '@/features/projects/modal/rename-project-modal';
import NewProjectControl from '@/features/projects/new-project-control';
import ProjectCard from '@/features/projects/project-card';
import { useAuth } from '@/features/providers/auth-provider';
import { invalidateAccountState, useAccountState } from '@/hooks/billing';
import {
  useLegacyMachines,
  useStartLegacyMigration,
} from '@/hooks/legacy/use-legacy-machine-migration';
import { billingApi } from '@/lib/api/billing';
import { isBillingEnabled } from '@/lib/config';
import {
  ensureFirstProject,
  hasFirstProjectBootstrapSignal,
  shouldAutoCreateFirstProject,
} from '@/lib/onboarding/ensure-first-project';
import {
  type KortixProject,
  archiveProject,
  listAccounts,
  listProjectsForAccount,
} from '@kortix/sdk/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { type ProjectsViewMode, useProjectsViewStore } from '@/stores/projects-view-store';
import { Search } from '@mynaui/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderPlus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PROJECT_SKELETON_KEYS = Array.from({ length: 6 }, (_, index) => `project-skeleton-${index}`);

export default function ProjectsPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const { viewMode, setViewMode } = useProjectsViewStore();
  const [query, setQuery] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<KortixProject | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createAccountId, setCreateAccountId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [firstProjectBootstrapRequested, setFirstProjectBootstrapRequested] = useState(() => {
    return hasFirstProjectBootstrapSignal(searchParams);
  });

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.toString());
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('team_signup') !== 'success') return;
    let cancelled = false;
    (async () => {
      try {
        await billingApi.syncSubscription();
        if (cancelled) return;
        await invalidateAccountState(queryClient);
        successToast('Subscription activated', {
          description: 'Your team is on Kortix Team. Compute and LLM credits are ready.',
        });
      } catch {
        invalidateAccountState(queryClient);
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('team_signup');
        window.history.replaceState(null, '', url.toString());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, queryClient]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts) return;

    const selectedExists = accounts.some((account) => account.account_id === selectedAccountId);
    const nextAccountId = selectedExists ? selectedAccountId : (accounts[0]?.account_id ?? null);
    if (nextAccountId !== selectedAccountId) setSelectedAccountId(nextAccountId);
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);

  const activeAccount =
    accountsQuery.data?.find((account) => account.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;
  const activeAccountId = activeAccount?.account_id ?? null;

  const projectsQuery = useQuery({
    queryKey: ['projects', activeAccountId],
    queryFn: () => listProjectsForAccount(activeAccountId || undefined),
    enabled: !!user && !!activeAccountId,
    staleTime: 20_000,
  });

  const canCreateProjects =
    activeAccount?.account_role === 'owner' || activeAccount?.account_role === 'admin';

  // "All accounts" is only meaningful when the user actually has more than one.
  // For solo users the page behaves exactly as before (no toggle, no headers).
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const isMultiAccount = accounts.length > 1;
  const viewAll = isMultiAccount && viewMode === 'all';

  // Accounts the user can create projects in — drives the New-project picker.
  const creatableAccounts = useMemo(
    () => accounts.filter((a) => a.account_role === 'owner' || a.account_role === 'admin'),
    [accounts],
  );

  // In "all" view we fetch projects for every account. These reuse the exact
  // same ['projects', accountId] cache keys as the single-account query above,
  // so toggling between views is instant once each account has loaded once.
  const allAccountQueries = useQueries({
    queries: viewAll
      ? accounts.map((a) => ({
          queryKey: ['projects', a.account_id],
          queryFn: () => listProjectsForAccount(a.account_id),
          staleTime: 20_000,
        }))
      : [],
  });

  const filterProjects = useCallback(
    (items: KortixProject[]) => {
      const q = query.trim().toLowerCase();
      if (!q) return items;
      return items.filter((project) =>
        [project.name, project.repo_url, project.default_branch]
          // repo_url / default_branch can be null for repo-less projects;
          // optional chaining short-circuits the whole chain to undefined.
          .some((value) => value?.toLowerCase().includes(q)),
      );
    },
    [query],
  );

  const accountGroups = viewAll
    ? accounts
        .map((account, i) => ({
          account,
          projects: filterProjects(allAccountQueries[i]?.data ?? []),
        }))
        .filter((group) => group.projects.length > 0)
    : [];

  const legacyMachinesQuery = useLegacyMachines({
    enabled: !!user && !!activeAccountId,
    accountId: activeAccountId,
  });
  const startMigration = useStartLegacyMigration(activeAccountId);

  // ── Onboarding: only explicit signup/subscription returns auto-bootstrap the
  // first project. A normal empty projects list can come from deleting the last
  // project, and must stay empty instead of recreating it.
  const { data: accountState, isLoading: accountStateLoading } = useAccountState({
    accountId: activeAccountId ?? undefined,
    enabled: !!user && !!activeAccountId,
  });
  const autoCreateAttempted = useRef<Set<string>>(new Set());
  const [autoCreating, setAutoCreating] = useState(false);

  useEffect(() => {
    const accountId = activeAccountId;
    const legacySandboxes = legacyMachinesQuery.data?.sandboxes;
    if (
      !shouldAutoCreateFirstProject({
        bootstrapRequested: firstProjectBootstrapRequested,
        activeAccountId: accountId,
        canCreateProjects,
        autoCreateAttempted: accountId ? autoCreateAttempted.current.has(accountId) : false,
        accountsLoading: accountsQuery.isLoading,
        projectsLoading: projectsQuery.isLoading,
        projectsError: projectsQuery.isError,
        projectsLoaded: !!projectsQuery.data,
        projectCount: projectsQuery.data?.length ?? 0,
        legacyMachinesLoaded: legacyMachinesQuery.isSuccess,
        legacyMachineCount: legacySandboxes?.length ?? 0,
        billingEnabled: isBillingEnabled(),
        accountStateLoading,
        canRun: !!accountState?.credits?.can_run,
      })
    ) {
      return;
    }
    if (!accountId) return;

    autoCreateAttempted.current.add(accountId);
    setFirstProjectBootstrapRequested(false);
    setAutoCreating(true);
    ensureFirstProject(accountId)
      .then((project) => {
        if (!project) {
          setAutoCreating(false);
          autoCreateAttempted.current.delete(accountId);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['projects', accountId] });
        router.replace(`/projects/${project.project_id}`);
      })
      .catch((err) => {
        autoCreateAttempted.current.delete(accountId);
        setAutoCreating(false);
        console.error('[onboarding] auto-create first project failed', err);
      });
  }, [
    activeAccountId,
    canCreateProjects,
    accountsQuery.isLoading,
    projectsQuery.isLoading,
    projectsQuery.isError,
    projectsQuery.data,
    legacyMachinesQuery.isSuccess,
    legacyMachinesQuery.data,
    firstProjectBootstrapRequested,
    accountStateLoading,
    accountState?.credits?.can_run,
    queryClient,
    router,
  ]);

  const handleMigrate = (sandboxId: string) =>
    startMigration.mutate(sandboxId, {
      onSuccess: () => successToast('Migration started — this runs in the background'),
      onError: (e: Error) => errorToast(e.message || 'Failed to start migration'),
    });

  const archiveMutation = useMutation({
    mutationFn: archiveProject,
    onMutate: (projectId) => setArchivingId(projectId),
    onSettled: () => setArchivingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      successToast('Project archived');
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to archive project');
    },
  });

  const filtered = useMemo(
    () => filterProjects(projectsQuery.data ?? []),
    [filterProjects, projectsQuery.data],
  );

  const projectIds = useMemo(
    () => new Set((projectsQuery.data ?? []).map((p) => p.project_id)),
    [projectsQuery.data],
  );

  const legacyMachines = useMemo(() => {
    const items = legacyMachinesQuery.data?.sandboxes ?? [];
    const q = query.trim().toLowerCase();
    return items.filter((machine) => {
      const projectId = machine.migration?.project_id;
      if (machine.migration?.status === 'completed' && projectId && projectIds.has(projectId)) {
        return false;
      }
      if (!q) return true;
      return machine.name.toLowerCase().includes(q) || machine.provider.toLowerCase().includes(q);
    });
  }, [legacyMachinesQuery.data, query, projectIds]);

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  // Bootstrapping the first project — hold the connecting screen instead of
  // flashing the empty "create your first project" state before the redirect.
  if (autoCreating) {
    return <ConnectingScreen forceConnecting hideWorkspacePicker />;
  }

  const total = projectsQuery.data?.length ?? 0;
  const totalLegacy = legacyMachinesQuery.data?.sandboxes?.length ?? 0;
  const showProjectsLoading = accountsQuery.isLoading || projectsQuery.isLoading;
  const showEmptyState =
    !!activeAccountId &&
    !showProjectsLoading &&
    !projectsQuery.isError &&
    total === 0 &&
    totalLegacy === 0;
  const showNoResults =
    !!activeAccountId &&
    !showProjectsLoading &&
    !projectsQuery.isError &&
    total + totalLegacy > 0 &&
    filtered.length === 0 &&
    legacyMachines.length === 0;

  const allRawTotal = viewAll
    ? accounts.reduce((n, _a, i) => n + (allAccountQueries[i]?.data?.length ?? 0), 0)
    : 0;
  const allFilteredTotal = accountGroups.reduce((n, g) => n + g.projects.length, 0);
  const showAllLoading =
    viewAll && (accountsQuery.isLoading || allAccountQueries.some((q) => q.isLoading));
  const showAllEmpty = viewAll && !showAllLoading && allRawTotal === 0 && totalLegacy === 0;
  const showAllNoResults =
    viewAll &&
    !showAllLoading &&
    allRawTotal + totalLegacy > 0 &&
    allFilteredTotal === 0 &&
    legacyMachines.length === 0;

  const openCreateModal = (accountId: string | null) => {
    setCreateAccountId(accountId);
    setModalOpen(true);
  };

  return (
    <div className="bg-foreground/5 flex min-h-screen flex-col">
      <AppHeader
        user={user}
        breadcrumb="Projects"
        actions={<UpgradeButton accountId={activeAccountId ?? undefined} />}
      />
      <main className="ring-input bg-background px-mobile flex-1 rounded-t-xl py-10 ring sm:py-12">
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <SunaMigrationBanner accountId={activeAccountId} />
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 space-y-1">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
                Projects
              </h1>
              <p className="text-muted-foreground text-base">
                {tHardcodedUi.raw(
                  'appProjectsPage.line216JsxTextYourWorkspacesOnePlacePickUpWhereYou',
                )}
              </p>
            </div>
            <div className="flex w-full min-w-0 flex-col gap-3 lg:w-auto lg:flex-row lg:items-center lg:gap-2">
              {isMultiAccount && (
                <Tabs
                  value={viewMode}
                  onValueChange={(v) => setViewMode(v as ProjectsViewMode)}
                  className="w-full lg:w-auto"
                >
                  <TabsList className="w-full lg:w-fit">
                    <TabsTrigger value="all" className="min-w-0 flex-1 lg:flex-initial">
                      {tI18nHardcoded.raw('autoAppAppProjectsPageJsxTextAllAccounts7f58297f')}
                    </TabsTrigger>
                    <TabsTrigger
                      value="account"
                      className="min-w-0 flex-1 lg:max-w-[10rem] lg:flex-initial"
                    >
                      <span className="truncate">{activeAccount?.name || 'This account'}</span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center lg:w-auto">
                <div className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tHardcodedUi.raw(
                      'appProjectsPage.line225JsxAttrPlaceholderSearchProjects',
                    )}
                    className="bg-foreground/10 w-full pl-9 text-sm"
                  />
                </div>
                <NewProjectControl
                  viewAll={viewAll}
                  creatableAccounts={creatableAccounts}
                  activeAccountId={activeAccountId}
                  canCreateActive={canCreateProjects}
                  onPick={openCreateModal}
                  label={tHardcodedUi.raw('appProjectsPage.line236JsxTextNewProject')}
                  fullWidth
                  className="sm:w-auto"
                />
              </div>
            </div>
          </div>

          {!viewAll && (
            <>
              {showProjectsLoading && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {PROJECT_SKELETON_KEYS.map((key) => (
                    <Skeleton key={key} className="h-[92px] rounded-2xl" />
                  ))}
                </div>
              )}

              {projectsQuery.isError && (
                <SectionCard flush>
                  <EmptyState
                    icon={AlertCircle}
                    title={tHardcodedUi.raw(
                      'appProjectsPage.line252JsxAttrTitleFailedToLoadProjects',
                    )}
                    description={(projectsQuery.error as Error).message}
                    action={
                      <Button variant="outline" size="sm" onClick={() => projectsQuery.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                </SectionCard>
              )}

              {showEmptyState && (
                <SectionCard flush>
                  <EmptyState
                    icon={FolderPlus}
                    title={tI18nHardcoded.raw(
                      'autoAppAppProjectsPageJsxAttrTitleNoProjectsYet85527dd3',
                    )}
                    description={tI18nHardcoded.raw(
                      'autoAppAppProjectsPageJsxAttrDescriptionAProjectIsa4dc84d2',
                    )}
                    action={
                      <Button
                        onClick={() => openCreateModal(activeAccountId)}
                        disabled={!canCreateProjects}
                      >
                        <Icon.Plus />
                        {tI18nHardcoded.raw(
                          'autoAppAppProjectsPageJsxTextCreateYourFirstProject061cafdb',
                        )}
                      </Button>
                    }
                  />
                </SectionCard>
              )}

              {showNoResults && (
                <SectionCard flush>
                  <EmptyState
                    icon={Search}
                    size="sm"
                    title={`No matches for "${query}"`}
                    description={tHardcodedUi.raw(
                      'appProjectsPage.line288JsxAttrDescriptionTryADifferentSearchTerm',
                    )}
                  />
                </SectionCard>
              )}

              {(filtered.length > 0 || legacyMachines.length > 0) && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {legacyMachines.map((machine) => (
                    <LegacyMachineCard
                      key={machine.sandbox_id}
                      machine={machine}
                      starting={
                        startMigration.isPending && startMigration.variables === machine.sandbox_id
                      }
                      onMigrate={() => handleMigrate(machine.sandbox_id)}
                      onOpenProject={(projectId) => router.push(`/projects/${projectId}`)}
                    />
                  ))}
                  {filtered.map((project) => (
                    <ProjectCard
                      key={project.project_id}
                      project={project}
                      onOpen={() => router.push(`/projects/${project.project_id}`)}
                      onRename={() => setRenameTarget(project)}
                      onArchive={() => archiveMutation.mutate(project.project_id)}
                      archiving={archivingId === project.project_id}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {viewAll && (
            <div className="space-y-10">
              {showAllLoading && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {PROJECT_SKELETON_KEYS.map((key) => (
                    <Skeleton key={key} className="h-[92px] rounded-2xl" />
                  ))}
                </div>
              )}

              {showAllEmpty && (
                <SectionCard flush>
                  <EmptyState
                    icon={FolderPlus}
                    title={tI18nHardcoded.raw(
                      'autoAppAppProjectsPageJsxAttrTitleNoProjectsYet85527dd3',
                    )}
                    description={tI18nHardcoded.raw(
                      'autoAppAppProjectsPageJsxAttrDescriptionAProjectIsa4dc84d2',
                    )}
                    action={
                      <NewProjectControl
                        viewAll
                        creatableAccounts={creatableAccounts}
                        activeAccountId={activeAccountId}
                        canCreateActive={canCreateProjects}
                        onPick={openCreateModal}
                        label={tI18nHardcoded.raw(
                          'autoAppAppProjectsPageJsxAttrLabelCreateYourFirst301a83a6',
                        )}
                      />
                    }
                  />
                </SectionCard>
              )}

              {showAllNoResults && (
                <SectionCard flush>
                  <EmptyState
                    icon={Search}
                    size="sm"
                    title={`No matches for "${query}"`}
                    description={tHardcodedUi.raw(
                      'appProjectsPage.line288JsxAttrDescriptionTryADifferentSearchTerm',
                    )}
                  />
                </SectionCard>
              )}

              {!showAllLoading && legacyMachines.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {legacyMachines.map((machine) => (
                    <LegacyMachineCard
                      key={machine.sandbox_id}
                      machine={machine}
                      starting={
                        startMigration.isPending && startMigration.variables === machine.sandbox_id
                      }
                      onMigrate={() => handleMigrate(machine.sandbox_id)}
                      onOpenProject={(projectId) => router.push(`/projects/${projectId}`)}
                    />
                  ))}
                </div>
              )}

              {!showAllLoading &&
                accountGroups.map((group) => (
                  <section key={group.account.account_id} className="space-y-4">
                    <div className="flex items-center gap-2.5">
                      <EntityAvatar label={group.account.name || 'Account'} size="sm" />
                      <h2 className="text-foreground text-sm font-semibold tracking-tight">
                        {group.account.name || 'Account'}
                      </h2>
                      <span className="text-muted-foreground text-xs">{group.projects.length}</span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {group.projects.map((project) => (
                        <ProjectCard
                          key={project.project_id}
                          project={project}
                          onOpen={() => {
                            setSelectedAccountId(group.account.account_id);
                            router.push(`/projects/${project.project_id}`);
                          }}
                          onRename={() => setRenameTarget(project)}
                          onArchive={() => archiveMutation.mutate(project.project_id)}
                          archiving={archivingId === project.project_id}
                        />
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </div>
      </main>

      <ProjectCreateModal
        open={modalOpen}
        onOpenChange={(o) => {
          setModalOpen(o);
          if (!o) setCreateAccountId(null);
        }}
        accountId={createAccountId ?? activeAccountId}
      />

      <RenameProjectDialog
        projectId={renameTarget?.project_id ?? null}
        currentName={renameTarget?.name}
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
      />

      <PersonalOnboardingWelcome />
      {isBillingEnabled() && <GlobalUpgradeModal />}
    </div>
  );
}
