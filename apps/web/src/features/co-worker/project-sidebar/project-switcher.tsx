'use client';

import { useTranslations } from 'next-intl';

/**
 * ProjectSwitcher — the standalone "which project" switcher.
 *
 * Scoped to the currently-selected account (account switching lives in the
 * Account·You menu, not here). Rendered in two places via `variant`:
 *  - `header`  — a compact pill in the top-bar breadcrumb.
 *  - `sidebar` — a full-width widget at the top of the project sidebar.
 *
 * Entity tiles use the design-system <EntityAvatar> (things are square).
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, FolderGit2, Search } from 'lucide-react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { listAccounts, listProjectsForAccount, type KortixProject } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useIsSwitchingProject, useProjectSwitchStore } from '@/stores/project-switch-store';
import { formatRelative } from '@kortix/shared';
import { CheckCircleSolid, ChevronsUpDownSolid } from '@mynaui/icons-react';

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

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!menuOpen) setQuery('');
  }, [menuOpen]);

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

  const label = activeProject?.name ?? 'Projects';
  const tile = activeProject ? (
    <EntityAvatar label={activeProject.name} size={variant === 'header' ? 'xs' : 'sm'} />
  ) : (
    <EntityAvatar icon={FolderGit2} size={variant === 'header' ? 'xs' : 'sm'} />
  );

  const trigger =
    variant === 'header' ? (
      <Button type="button" className={cn(className)}>
        {tile}
        <span className="max-w-40 truncate text-sm font-medium">{label}</span>
        <ChevronsUpDownSolid className="text-muted-foreground size-3" />
      </Button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/trigger relative h-auto gap-2 border border-transparent bg-transparent px-1.5 py-1',
        )}
      >
        {tile}
        <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <ChevronsUpDown className="text-muted-foreground/40 ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    );

  if (accountsQuery.isLoading && !activeAccount) {
    return variant === 'header' ? (
      <Skeleton className={cn('h-8 w-36 rounded-md', className)} />
    ) : (
      <Skeleton className="h-9 w-full rounded-lg" />
    );
  }

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        className={cn(
          'overflow-hidden p-0 light:bg-background ',
          variant === 'sidebar'
            ? 'w-(--radix-dropdown-menu-trigger-width) min-w-64 shadow-none'
            : 'w-64',
        )}
      >
        {showSearch && (
          <div className="border-border/40 border-b px-2 py-2">
            <div className="relative">
              <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsLayoutProjectSwitcher.line210JsxAttrPlaceholderFindProject',
                )}
                className="placeholder:text-muted-foreground/50 h-8 pr-2 pl-7 text-sm"
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
                    className={cn('cursor-pointer', active && 'bg-muted/60')}
                  >
                    <EntityAvatar label={project.name} size="sm" />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                    </div>
                    {loading ? (
                      <Loading className="text-muted-foreground size-3.5" />
                    ) : active ? (
                      <CheckCircleSolid className="text-kortix-green size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="my-0" />

        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
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

  return variant === 'sidebar' ? (
    <SidebarMenu>
      <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
        {dropdown}
      </SidebarMenuItem>
    </SidebarMenu>
  ) : (
    dropdown
  );
}
