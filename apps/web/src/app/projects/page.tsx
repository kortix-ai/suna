'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useCurrentAccountStore } from '@/stores/current-account-store';
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

export default function ProjectsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [query, setQuery] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
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

  // Legacy machines live right in the projects grid as cards with a "must be
  // migrated" badge, so they're impossible to miss and feel like everything
  // else. The query only runs for users who actually have any.
  const legacyMachinesQuery = useLegacyMachines({
    enabled: !!user && !!activeAccountId,
    accountId: activeAccountId,
  });
  const startMigration = useStartLegacyMigration(activeAccountId);

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

  const filtered = useMemo(() => {
    const items = projectsQuery.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((project) =>
      [project.name, project.repo_url, project.default_branch]
        // repo_url / default_branch can be null for repo-less projects;
        // optional chaining short-circuits the whole chain to undefined.
        .some((value) => value?.toLowerCase().includes(q)),
    );
  }, [projectsQuery.data, query]);

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
              <div className="relative flex-1 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tHardcodedUi.raw('appProjectsPage.line225JsxAttrPlaceholderSearchProjects')}
                  className="h-9 pl-9 text-sm"
                />
              </div>
              <Button
                onClick={() => setModalOpen(true)}
                disabled={!activeAccountId || !canCreateProjects}
                size="sm"
                className="h-9 gap-1.5"
              >
                <Plus className="h-4 w-4" />{tHardcodedUi.raw('appProjectsPage.line236JsxTextNewProject')}</Button>
            </div>
          </div>

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
                    onClick={() => setModalOpen(true)}
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
        </div>
      </main>

      <ProjectCreateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        accountId={activeAccountId}
      />

      <PersonalOnboardingWelcome />
    </div>
  );
}
