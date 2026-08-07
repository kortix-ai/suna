'use client';

/**
 * WorkspaceSwitcher — the standalone "which project" switcher.
 *
 * The ONLY complete workspace directory in the product: it lists every
 * workspace in every account the user belongs to, grouped by account (account
 * switching itself lives in the Account·You menu, not here). Rendered in two
 * places via `variant`:
 *  - `header`  — a compact pill in the top-bar breadcrumb.
 *  - `sidebar` — the merged brand/switcher control at the top of the project
 *    sidebar: one shell, two segments. The Kortix mark navigates to the
 *    project's home; the name opens this menu. They used to be two unrelated
 *    controls sitting next to each other — same subject ("where am I, where do
 *    I go"), mismatched heights, radii and weights, with dead unclickable space
 *    between them. Fusing them into one shell that hovers and presses as a unit
 *    keeps both destinations one click away and reads as a single object.
 *
 * Entity tiles use the design-system <EntityAvatar> (things are square).
 */

import { GitBranchIcon as FolderGit2, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { SidebarContext } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Kortix } from '@/features/icon/icons/kortix';
import { resolveSwitcherLabel } from '@/features/workspace/project-sidebar/project-switcher-label';
import {
  filterWorkspaceGroups,
  groupWorkspacesByAccount,
} from '@/features/workspace/project-sidebar/workspace-grouping';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useIsSwitchingProject, useProjectSwitchStore } from '@/stores/project-switch-store';
import {
  getProjectDetail,
  listAccounts,
  listProjectsForAccount,
  type KortixProject,
} from '@kortix/sdk';
import { CaretUpDownIcon, CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';

export type WorkspaceSwitcherVariant = 'header' | 'sidebar';

export function WorkspaceSwitcher({
  variant = 'header',
  className,
}: {
  variant?: WorkspaceSwitcherVariant;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const appHome = useAppHome();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useProjectSwitchStore((s) => s.beginSwitch);
  const endSwitch = useProjectSwitchStore((s) => s.endSwitch);
  const switching = useIsSwitchingProject();

  // Read through the context rather than useSidebar(): the `header` variant can
  // render outside a SidebarProvider, where the hook throws.
  const sidebar = useContext(SidebarContext);

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!menuOpen) setQuery('');
  }, [menuOpen]);

  // While the panel is a hover flyout, moving the pointer onto this menu leaves
  // the panel and would collapse it out from under the open menu — the menu is
  // portaled, so it would survive alone. Hold the peek open for as long as the
  // menu is, same contract as the session filter menu.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      sidebar?.holdPeek(open);
    },
    [sidebar],
  );

  const activeProjectId = pathname?.startsWith('/projects/') ? params?.id : undefined;

  // Account switching lives in the Account·You menu. `activeAccount` has
  // exactly one live use below: gating the header-variant loading skeleton
  // until accounts resolve. Group sort-first priority is NOT this selection —
  // `groupWorkspacesByAccount` computes it from the OPEN PROJECT's account via
  // `activeProjectId`, independent of what's selected here.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });
  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  // Every account the user belongs to, and every workspace in each. This menu
  // is the ONLY complete workspace directory now that the /projects index is
  // gone, so it lists all accounts' workspaces, not just the selected
  // account's. `GET /projects` with no `account_id` scopes server-side to a
  // single default account (apps/api resolveProjectAccount ->
  // resolveAccountId), so there is no single unscoped call that returns
  // everything — one listProjectsForAccount call per account, fanned out with
  // useQueries and flattened below.
  const accountsForWorkspaces = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const workspaceQueries = useQueries({
    queries: accountsForWorkspaces.map((account) => ({
      queryKey: ['projects', account.account_id],
      queryFn: () => listProjectsForAccount(account.account_id),
      staleTime: 30_000,
    })),
  });
  // Loading until accounts themselves are known AND every account's
  // workspaces are in. Without `accountsQuery.isLoading` this is `false`
  // while accounts are still in flight (`workspaceQueries` starts as `[]`,
  // and `[].some(...)` is `false` by definition) — the menu would paint "No
  // workspaces yet" before it has even asked how many accounts exist.
  const workspacesLoading = accountsQuery.isLoading || workspaceQueries.some((q) => q.isLoading);
  const allWorkspaces = workspaceQueries.flatMap((q) => q.data ?? []);

  // Accounts whose workspace fetch failed. `workspaceQueries[i]` belongs to
  // `accountsForWorkspaces[i]` — both built from the same array in the same
  // order — so this is a zip by index, not a second fetch or a lookup by id.
  // A failed account still gets its group header and a single retry row
  // instead of silently looking empty: `groupWorkspacesByAccount` drops any
  // account with zero workspaces, and `undefined` data folds to `[]` on
  // error, so without this the account would vanish indistinguishably from
  // "genuinely has no workspaces" — exactly the failure this menu exists to
  // prevent now that it is the only complete workspace directory.
  const failedAccounts = accountsForWorkspaces
    .map((account, i) => ({ account, result: workspaceQueries[i] }))
    .filter(({ result }) => result.isError);

  const activeProject = useMemo(
    () =>
      activeProjectId
        ? (allWorkspaces.find((p) => p.project_id === activeProjectId) ?? null)
        : null,
    [allWorkspaces, activeProjectId],
  );

  // The project list is the slow way to learn the open project's name — it
  // waits on `accounts` first. This is the SAME cache entry the project shell
  // already fetches on mount, so subscribing costs no extra request and names
  // the project as early as anything on the page can.
  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', activeProjectId],
    queryFn: () => getProjectDetail(activeProjectId as string),
    enabled: !!activeProjectId,
  });
  const { label: switcherLabel, pending: labelPending } = resolveSwitcherLabel({
    activeProjectId,
    activeProjectName: activeProject?.name ?? projectDetailQuery.data?.project?.name ?? null,
  });

  useEffect(() => {
    if (!activeProjectId) return;
    const target = useProjectSwitchStore.getState().targetProjectId;
    if (target && target === activeProjectId) endSwitch();
  }, [activeProjectId, endSwitch]);

  // Grouping and filtering both go through the shared helpers — never sorted
  // or sliced here. `filterWorkspaceGroups` returns the original group/array
  // references on the empty-query and account-name-match paths, so this
  // component only ever reads them.
  const groups = useMemo(
    () =>
      groupWorkspacesByAccount({
        accounts: accountsForWorkspaces,
        workspaces: allWorkspaces,
        activeWorkspaceId: activeProjectId ?? null,
      }),
    [accountsForWorkspaces, allWorkspaces, activeProjectId],
  );
  const visibleGroups = useMemo(() => filterWorkspaceGroups(groups, query), [groups, query]);
  // A failed account never appears in `groups` (it has zero workspaces, and
  // `groupWorkspacesByAccount` drops those), so it must not count toward
  // "empty" either — that would show "No workspaces yet" over an account we
  // simply failed to load, instead of that account's own retry row.
  const isEmpty = visibleGroups.length === 0 && failedAccounts.length === 0;

  const close = () => setMenuOpen(false);
  const switchProject = (project: KortixProject) => {
    if (project.project_id === activeProjectId) return close();
    beginSwitch(project.project_id);
    if (project.account_id !== selectedAccountId) {
      setSelectedAccountId(project.account_id);
    }
    close();
    router.push(`/projects/${project.project_id}`);
  };

  // Header variant only. The sidebar variant leads with the Kortix mark
  // instead — see the merged control below.
  const tile = labelPending ? (
    // Placeholder, not a guess: the initial tile is derived from the name, so
    // showing one before we have the name would swap letters mid-load.
    <Skeleton className="size-5 shrink-0 rounded-sm" />
  ) : activeProjectId && switcherLabel ? (
    <EntityAvatar label={switcherLabel} size="xs" />
  ) : (
    <EntityAvatar icon={FolderGit2} size="xs" />
  );

  // Where the mark goes. Off a project route it takes you back into the app —
  // the latest project you had open, same "take me into the app" destination
  // as every other implicit entry point. Never `/projects`: that's a redirect
  // now, and the mark would dead-end the moment it fired.
  const homeHref = activeProjectId ? `/projects/${activeProjectId}` : appHome;
  const homeLabel = activeProjectId ? 'Project home' : 'Home';

  const trigger =
    variant === 'header' ? (
      <DropdownMenuTrigger asChild>
        <Button type="button" className={cn(className)}>
          {tile}
          {labelPending ? null : (
            <span className="w-fit max-w-40 truncate text-sm font-medium">{switcherLabel}</span>
          )}
          <CaretUpDownIcon weight="fill" className="text-muted-foreground size-3" />
        </Button>
      </DropdownMenuTrigger>
    ) : (
      <div
        data-slot="workspace-switcher"
        className={cn(
          'group/switcher flex h-8 w-fit max-w-full min-w-0 items-center overflow-hidden rounded-sm border border-transparent',
          'transition-[background-color,border-color,transform] duration-150 ease-out',
          'hover:border-border/60 hover:bg-sidebar-accent/40',
          'has-data-[state=open]:border-border/60 has-data-[state=open]:bg-sidebar-accent/40',
          'has-[:active]:scale-[0.98]',
          className,
        )}
      >
        <Link
          href={homeHref}
          aria-label={homeLabel}
          className="text-foreground hover:bg-sidebar-accent focus-visible:ring-primary/30 flex h-full shrink-0 items-center justify-center rounded-s-sm px-2 transition-colors duration-150 ease-out outline-none focus-visible:rounded-sm focus-visible:ring-[0.6px]"
        >
          <Kortix className="size-4" />
        </Link>
        {!labelPending ? (
          <>
            {/* Seam. Absent at rest so the shell reads as one surface; drawn on
                hover so the two hit areas are discoverable before they are
                clicked, and never after the pointer has left. */}
            <span
              aria-hidden
              className="bg-border/0 group-hover/switcher:bg-border/70 h-full w-px shrink-0 transition-colors duration-150 ease-out"
            />
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Switch workspace"
                className="hover:bg-sidebar-accent focus-visible:ring-primary/30 flex h-full max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-e-sm pr-1.5 pl-2 text-left transition-colors duration-150 ease-out outline-none focus-visible:rounded-sm focus-visible:ring-[0.6px]"
              >
                <span className="text-foreground min-w-0 truncate text-sm font-medium tracking-tight whitespace-nowrap">
                  {switcherLabel}
                </span>
                <CaretUpDownIcon className="text-muted-foreground/50 group-hover/switcher:text-muted-foreground size-3.5 shrink-0 transition-colors duration-150 ease-out" />
              </button>
            </DropdownMenuTrigger>
          </>
        ) : null}
      </div>
    );

  // Sidebar: never blank the control while accounts load. The home link is
  // known from first paint; the project switch trigger appears with its label.
  if (accountsQuery.isLoading && !activeAccount && variant === 'header') {
    return <Skeleton className={cn('h-8 w-36 rounded-md', className)} />;
  }

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange}>
      {trigger}
      <DropdownMenuContent
        align="start"
        side="bottom"
        className={cn(
          'bg-background dark:bg-sidebar overflow-hidden p-0',
          // Fixed width, not the trigger's: in the sidebar the trigger is the
          // name segment, so trigger-width would size the menu to a fragment of
          // the control it belongs to.
          variant === 'sidebar' ? 'w-64 shadow-md' : 'w-64',
        )}
      >
        {/* Always mounted. The /projects index is gone, so this menu is the
            whole directory — a conditional search box would make workspace
            N+7 unreachable for anyone with more than a handful. */}
        <div className="border-border/40 border-b px-2 py-2">
          <div className="relative">
            <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find workspace…"
              className="placeholder:text-muted-foreground/50 h-8 pr-2 pl-8 text-sm"
            />
          </div>
        </div>

        <div className="max-h-[320px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {workspacesLoading ? (
            <div className="space-y-1 p-1">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-7 rounded-md" />
              ))}
            </div>
          ) : isEmpty ? (
            <div className="text-muted-foreground/60 px-2 py-3 text-xs">
              {query.trim() ? 'No workspaces match' : 'No workspaces yet'}
            </div>
          ) : (
            <>
              {visibleGroups.map((group) => (
                <DropdownMenuGroup key={group.accountId}>
                  <DropdownMenuLabel>{group.accountName}</DropdownMenuLabel>
                  {group.workspaces.map((workspace) => {
                    const active = workspace.project_id === activeProjectId;
                    const loading = switching && workspace.project_id !== activeProjectId;
                    return (
                      <DropdownMenuItem
                        key={workspace.project_id}
                        disabled={loading}
                        onSelect={() => switchProject(workspace)}
                        className={cn('cursor-pointer', active && 'bg-muted/80')}
                      >
                        <EntityAvatar label={workspace.name} emoji={workspace.icon} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {workspace.name}
                        </span>
                        {loading ? (
                          <Loading className="text-muted-foreground size-3.5" />
                        ) : active ? (
                          <CheckCircleSolid
                            weight="fill"
                            className="text-kortix-green size-3.5 shrink-0"
                          />
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
              {/* Rendered after the successful groups, and NOT filtered by
                  `query`: a search match could be hiding inside the account
                  that failed, so hiding this on a search would tell the user
                  something false. */}
              {failedAccounts.map(({ account, result }) => (
                <DropdownMenuGroup key={account.account_id}>
                  <DropdownMenuLabel>{account.name?.trim() || 'Account'}</DropdownMenuLabel>
                  <div className="text-muted-foreground flex w-full items-center gap-2 px-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">Couldn't load</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={result.isFetching}
                      onClick={() => result.refetch()}
                      className="shrink-0"
                    >
                      {result.isFetching ? <Loading className="size-3.5 shrink-0" /> : 'Retry'}
                    </Button>
                  </div>
                </DropdownMenuGroup>
              ))}
            </>
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />

        <DropdownMenuGroup>
          <DropdownMenuItem
            className="cursor-pointer font-medium"
            onSelect={() => {
              close();
              router.push('/new');
            }}
          >
            Create a workspace…
          </DropdownMenuItem>
          {activeAccount && (
            <DropdownMenuItem
              className="cursor-pointer font-medium"
              onSelect={() => {
                close();
                router.push(`/accounts/${activeAccount.account_id}`);
              }}
            >
              Account settings
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // No SidebarMenu/<ul> wrapper any more: this is one control in a header row,
  // not a menu list, and the list semantics were being announced for a single
  // item.
  return dropdown;
}
