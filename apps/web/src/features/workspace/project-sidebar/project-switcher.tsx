'use client';

import { useTranslations } from 'next-intl';

/**
 * ProjectSwitcher — the standalone "which project" switcher.
 *
 * Scoped to the currently-selected account (account switching lives in the
 * Account·You menu, not here). Rendered in two places via `variant`:
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
import { useQuery } from '@tanstack/react-query';
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
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useIsSwitchingProject, useProjectSwitchStore } from '@/stores/project-switch-store';
import {
  getProjectDetail,
  listAccounts,
  listProjectsForAccount,
  type KortixProject,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { formatRelative } from '@kortix/shared';
import { CaretUpDownIcon, CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';

export type ProjectSwitcherVariant = 'header' | 'sidebar';

export function ProjectSwitcher({
  variant = 'header',
  className,
}: {
  variant?: ProjectSwitcherVariant;
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { selectedAccountId } = useCurrentAccountStore();
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

  // Account switching lives in the Account·You menu; here we just read the
  // selected account to scope the project list.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });
  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  const projectsQuery = useQuery({
    queryKey: ['projects', activeAccount?.account_id],
    queryFn: () => listProjectsForAccount(activeAccount?.account_id),
    enabled: !!activeAccount,
    staleTime: 30_000,
  });

  const activeProject = useMemo(
    () =>
      activeProjectId && projectsQuery.data
        ? (projectsQuery.data.find((p) => p.project_id === activeProjectId) ?? null)
        : null,
    [projectsQuery.data, activeProjectId],
  );

  // The project list is the slow way to learn the open project's name — it
  // waits on `accounts` first. This is the SAME cache entry the project shell
  // already fetches on mount, so subscribing costs no extra request and names
  // the project as early as anything on the page can.
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(activeProjectId ?? ''),
    queryFn: () => getProjectDetail(activeProjectId as string),
    enabled: !!activeProjectId,
    ...contract('config'),
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

  const allProjectsSorted = useMemo(() => {
    const list = [...(projectsQuery.data ?? [])];
    list.sort((a, b) => {
      const at = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
      const bt = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
      return bt - at;
    });
    return list;
  }, [projectsQuery.data]);

  const showSearch = allProjectsSorted.length > 6;
  const filteredProjects = useMemo(() => {
    if (!query.trim()) return allProjectsSorted.slice(0, 8);
    const q = query.trim().toLowerCase();
    return allProjectsSorted.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [allProjectsSorted, query]);

  const close = () => setMenuOpen(false);
  const switchProject = (project: KortixProject) => {
    if (project.project_id === activeProjectId) return close();
    beginSwitch(project.project_id);
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

  // Where the mark goes. Off a project route the switcher is genuinely the
  // "all projects" entry, and so is its mark.
  const homeHref = activeProjectId ? `/projects/${activeProjectId}` : '/projects';
  const homeLabel = activeProjectId ? 'Project home' : 'All projects';

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
        data-slot="project-switcher"
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
                aria-label="Switch project"
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
        {showSearch && (
          <div className="border-border/40 border-b px-2 py-2">
            <div className="relative">
              <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsLayoutProjectSwitcher.line210JsxAttrPlaceholderFindProject',
                )}
                className="placeholder:text-muted-foreground/50 h-8 pr-2 pl-8 text-sm"
              />
            </div>
          </div>
        )}

        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          <div className="max-h-[280px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {projectsQuery.isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-7 rounded-md" />
                ))}
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="text-muted-foreground/60 px-2 py-3 text-xs">
                {query.trim() ? 'No projects match' : 'No projects yet'}
              </div>
            ) : (
              filteredProjects.map((project) => {
                const active = project.project_id === activeProjectId;
                const loading = switching && project.project_id !== activeProjectId;
                const relative = formatRelative(project.last_opened_at, { maxRelativeDays: 7 });
                return (
                  <DropdownMenuItem
                    key={project.project_id}
                    disabled={loading}
                    onSelect={() => switchProject(project)}
                    className={cn('cursor-pointer', active && 'bg-muted/80')}
                  >
                    <EntityAvatar label={project.name} emoji={project.icon} size="sm" />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                    </div>
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
              })
            )}
          </div>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="my-0" />

        <DropdownMenuGroup>
          <DropdownMenuItem
            className="cursor-pointer font-medium"
            onSelect={() => {
              close();
              router.push('/projects');
            }}
          >
            {tHardcodedUi.raw('componentsLayoutProjectSwitcher.line281JsxTextAllProjects')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer font-medium"
            onSelect={() => {
              close();
              router.push('/projects?new=1');
            }}
          >
            {tHardcodedUi.raw('componentsLayoutProjectSwitcher.line293JsxTextNewProject')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // No SidebarMenu/<ul> wrapper any more: this is one control in a header row,
  // not a menu list, and the list semantics were being announced for a single
  // item.
  return dropdown;
}
