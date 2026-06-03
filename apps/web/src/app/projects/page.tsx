'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { ProjectCreateModal } from '@/components/projects/project-create-modal';
import { LegacyMachineCard } from '@/components/projects/legacy-machine-card';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { useLegacyMachines, useStartLegacyMigration } from '@/hooks/legacy/use-legacy-machine-migration';
import {
  archiveProject,
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  useProjectsViewStore,
  type ProjectsViewMode,
} from '@/stores/projects-view-store';
import { billingApi } from '@/lib/api/billing';
import { invalidateAccountState } from '@/hooks/billing';

function relativeTime(input: string) {
  const date = new Date(input);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function ProjectCard({
  project,
  onOpen,
  onArchive,
  archiving,
}: {
  project: KortixProject;
  onOpen: () => void;
  onArchive: () => void;
  archiving: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const updatedLabel = relativeTime(project.updated_at);
  const canManageProject = project.effective_project_role === 'manager' || !project.effective_project_role;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border border-border/60 bg-card',
        'transition-all duration-150 hover:border-foreground/30 hover:bg-muted/30 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 cursor-pointer flex-col items-start gap-4 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-2xl"
      >
        <div className="flex w-full items-center gap-3">
          <EntityAvatar label={project.name} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold leading-tight text-foreground">
              {project.name}
            </h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              Updated {updatedLabel}
            </p>
          </div>
        </div>
      </button>

      <div className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 bg-background/80 backdrop-blur text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={tHardcodedUi.raw('appProjectsPage.line103JsxAttrAriaLabelProjectActions')}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onOpen}>{tHardcodedUi.raw('appProjectsPage.line109JsxTextOpenProject')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onArchive}
              disabled={archiving || !canManageProject}
              className="gap-2 text-muted-foreground focus:text-foreground"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// "New project" trigger. In single-account view it's a plain button against the
// active account. In all-accounts view a project has to be created *somewhere*,
// so it becomes a picker of the accounts the user can create in (collapsing to a
// direct button when there's exactly one such account).
function NewProjectControl({
  viewAll,
  creatableAccounts,
  activeAccountId,
  canCreateActive,
  onPick,
  label,
  fullWidth,
}: {
  viewAll: boolean;
  creatableAccounts: KortixAccount[];
  activeAccountId: string | null;
  canCreateActive: boolean;
  onPick: (accountId: string) => void;
  label: string;
  fullWidth?: boolean;
}) {
  const classes = cn('h-9 gap-1.5', fullWidth && 'w-full');

  if (!viewAll) {
    return (
      <Button
        onClick={() => activeAccountId && onPick(activeAccountId)}
        disabled={!activeAccountId || !canCreateActive}
        size="sm"
        className={classes}
      >
        <Plus className="h-4 w-4" />
        {label}
      </Button>
    );
  }

  if (creatableAccounts.length === 0) {
    return (
      <Button disabled size="sm" className={classes}>
        <Plus className="h-4 w-4" />
        {label}
      </Button>
    );
  }

  if (creatableAccounts.length === 1) {
    const only = creatableAccounts[0];
    return (
      <Button onClick={() => onPick(only.account_id)} size="sm" className={classes}>
        <Plus className="h-4 w-4" />
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className={classes}>
          <Plus className="h-4 w-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          Create in
        </div>
        {creatableAccounts.map((account) => (
          <DropdownMenuItem
            key={account.account_id}
            onSelect={() => onPick(account.account_id)}
            className="flex items-center gap-2.5"
          >
            <EntityAvatar label={account.name || 'Account'} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm">
              {account.name || 'Account'}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function ProjectsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const { viewMode, setViewMode } = useProjectsViewStore();
  const [query, setQuery] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Which account a newly-created project lands in. In "all accounts" view the
  // user picks it via the New-project dropdown; otherwise it's the active one.
  const [createAccountId, setCreateAccountId] = useState<string | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Project selector elsewhere in the app can deep-link to "open the new
  // project modal" via ?new=1. Consume it once on mount, then strip the
  // query so reloads don't keep popping the modal.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.toString());
    }
  }, [searchParams]);

  // Return from the Team plan Stripe Checkout (?team_signup=success). Reconcile
  // the subscription from Stripe so the account reflects the new plan + credits
  // immediately — don't depend on the webhook landing first. Then refresh
  // account state and strip the param so reloads don't re-fire.
  useEffect(() => {
    if (searchParams.get('team_signup') !== 'success') return;
    let cancelled = false;
    (async () => {
      try {
        await billingApi.syncSubscription();
        if (cancelled) return;
        await invalidateAccountState(queryClient);
        toast.success('Subscription activated', {
          description: 'Your team is on Kortix Team. Compute and LLM credits are ready.',
        });
      } catch {
        // Webhook will reconcile shortly; just refresh what we can.
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

  // Per-account groups for the "all" view, search-filtered, empties dropped.
  const accountGroups = viewAll
    ? accounts
        .map((account, i) => ({
          account,
          projects: filterProjects(allAccountQueries[i]?.data ?? []),
        }))
        .filter((group) => group.projects.length > 0)
    : [];

  // Legacy machines live right in the projects grid as cards with a "must be
  // migrated" badge, so they're impossible to miss and feel like everything
  // else. The query only runs for users who actually have any.
  const legacyMachinesQuery = useLegacyMachines({ enabled: !!user });
  const startMigration = useStartLegacyMigration();

  const handleMigrate = (sandboxId: string) =>
    startMigration.mutate(sandboxId, {
      onSuccess: () => toast.success('Migration started — this runs in the background'),
      onError: (e: Error) => toast.error(e.message || 'Failed to start migration'),
    });

  const archiveMutation = useMutation({
    mutationFn: archiveProject,
    onMutate: (projectId) => setArchivingId(projectId),
    onSettled: () => setArchivingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project archived');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to archive project');
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
      // A finished migration is its own real project card now — drop the
      // duplicate once that project shows up in the list.
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

  const total = projectsQuery.data?.length ?? 0;
  const totalLegacy = legacyMachinesQuery.data?.sandboxes?.length ?? 0;
  const showProjectsLoading = accountsQuery.isLoading || projectsQuery.isLoading;
  const showEmptyState =
    !!activeAccountId && !showProjectsLoading && !projectsQuery.isError && total === 0 && totalLegacy === 0;
  const showNoResults =
    !!activeAccountId &&
    !showProjectsLoading &&
    !projectsQuery.isError &&
    total + totalLegacy > 0 &&
    filtered.length === 0 &&
    legacyMachines.length === 0;

  // All-accounts view flags. allRawTotal counts unfiltered projects across every
  // account so the empty state distinguishes "no projects anywhere" from "no
  // search matches".
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
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} breadcrumb="Projects" />
      <main className="flex-1 px-4 py-10 sm:py-12">
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Projects
              </h1>
              <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appProjectsPage.line216JsxTextYourWorkspacesOnePlacePickUpWhereYou')}</p>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              {isMultiAccount && (
                <Tabs
                  value={viewMode}
                  onValueChange={(v) => setViewMode(v as ProjectsViewMode)}
                >
                  <TabsList size="sm">
                    <TabsTrigger value="all" className="cursor-pointer">
                      All accounts
                    </TabsTrigger>
                    <TabsTrigger
                      value="account"
                      className="max-w-[10rem] cursor-pointer"
                    >
                      <span className="truncate">
                        {activeAccount?.name || 'This account'}
                      </span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <div className="relative flex-1 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tHardcodedUi.raw('appProjectsPage.line225JsxAttrPlaceholderSearchProjects')}
                  className="h-9 pl-9 text-sm"
                />
              </div>
              <NewProjectControl
                viewAll={viewAll}
                creatableAccounts={creatableAccounts}
                activeAccountId={activeAccountId}
                canCreateActive={canCreateProjects}
                onPick={openCreateModal}
                label={tHardcodedUi.raw('appProjectsPage.line236JsxTextNewProject')}
              />
            </div>
          </div>

          {!viewAll && (
            <>
              {showProjectsLoading && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-[92px] rounded-2xl" />
                  ))}
                </div>
              )}

              {projectsQuery.isError && (
                <SectionCard
                  tone="destructive"
                  title={tHardcodedUi.raw('appProjectsPage.line252JsxAttrTitleFailedToLoadProjects')}
                  description={(projectsQuery.error as Error).message}
                >
                  <Button variant="outline" size="sm" onClick={() => projectsQuery.refetch()}>
                    Retry
                  </Button>
                </SectionCard>
              )}

              {showEmptyState && (
                <SectionCard flush>
                  <EmptyState
                    icon={FolderPlus}
                    title="No projects yet"
                    description="A project is a dedicated space for one company, product, or idea."
                    action={
                      <Button
                        onClick={() => openCreateModal(activeAccountId)}
                        disabled={!canCreateProjects}
                        size="sm"
                        className="gap-1.5"
                      >
                        <Plus className="h-4 w-4" />
                        Create your first project
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
                    description={tHardcodedUi.raw('appProjectsPage.line288JsxAttrDescriptionTryADifferentSearchTerm')}
                  />
                </SectionCard>
              )}

              {(filtered.length > 0 || legacyMachines.length > 0) && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {legacyMachines.map((machine) => (
                    <LegacyMachineCard
                      key={machine.sandbox_id}
                      machine={machine}
                      starting={startMigration.isPending && startMigration.variables === machine.sandbox_id}
                      onMigrate={() => handleMigrate(machine.sandbox_id)}
                      onOpenProject={(projectId) => router.push(`/projects/${projectId}`)}
                    />
                  ))}
                  {filtered.map((project) => (
                    <ProjectCard
                      key={project.project_id}
                      project={project}
                      onOpen={() => router.push(`/projects/${project.project_id}`)}
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
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-[92px] rounded-2xl" />
                  ))}
                </div>
              )}

              {showAllEmpty && (
                <SectionCard flush>
                  <EmptyState
                    icon={FolderPlus}
                    title="No projects yet"
                    description="A project is a dedicated space for one company, product, or idea."
                    action={
                      <NewProjectControl
                        viewAll
                        creatableAccounts={creatableAccounts}
                        activeAccountId={activeAccountId}
                        canCreateActive={canCreateProjects}
                        onPick={openCreateModal}
                        label="Create your first project"
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
                    description={tHardcodedUi.raw('appProjectsPage.line288JsxAttrDescriptionTryADifferentSearchTerm')}
                  />
                </SectionCard>
              )}

              {!showAllLoading && legacyMachines.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {legacyMachines.map((machine) => (
                    <LegacyMachineCard
                      key={machine.sandbox_id}
                      machine={machine}
                      starting={startMigration.isPending && startMigration.variables === machine.sandbox_id}
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
                      <h2 className="text-sm font-semibold tracking-tight text-foreground">
                        {group.account.name || 'Account'}
                      </h2>
                      <span className="text-xs text-muted-foreground">
                        {group.projects.length}
                      </span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {group.projects.map((project) => (
                        <ProjectCard
                          key={project.project_id}
                          project={project}
                          onOpen={() => {
                            // Switch the active account so deeper navigation
                            // (members, settings, billing) follows the project
                            // you just opened, not the previously-active one.
                            setSelectedAccountId(group.account.account_id);
                            router.push(`/projects/${project.project_id}`);
                          }}
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

      <PersonalOnboardingWelcome />
    </div>
  );
}
