'use client';

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

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, ChevronsUpDown, FolderGit2, Loader2, Plus, Search } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import {
  listAccounts,
  listProjectsForAccount,
  type KortixProject,
} from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  useIsSwitchingProject,
  useProjectSwitchStore,
} from '@/stores/project-switch-store';

export type ProjectSwitcherVariant = 'header' | 'sidebar';

function formatRelative(input: string | null | undefined) {
  if (!input) return null;
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(input).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ProjectSwitcher({
  variant = 'header',
  className,
}: {
  variant?: ProjectSwitcherVariant;
  className?: string;
}) {
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
        ? projectsQuery.data.find((p) => p.project_id === activeProjectId) ?? null
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
      <button
        type="button"
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-foreground transition-colors',
          'hover:bg-muted/50 data-[state=open]:bg-muted/60',
          className,
        )}
      >
        {tile}
        <span className="max-w-40 truncate text-[13px] font-medium">{label}</span>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />
      </button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/trigger relative h-auto gap-2 rounded-lg border border-transparent bg-transparent px-1.5 py-1',
          'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!px-0',
        )}
      >
        {tile}
        <span className="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold tracking-tight text-foreground group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <ChevronsUpDown className="ml-auto size-3 shrink-0 text-muted-foreground/40 group-data-[collapsible=icon]:hidden" />
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
        sideOffset={6}
        className={cn(
          'overflow-hidden rounded-2xl border-border/60 p-0',
          variant === 'sidebar' ? 'w-(--radix-dropdown-menu-trigger-width) min-w-56 shadow-none' : 'w-64',
        )}
      >
        {showSearch && (
          <div className="border-b border-border/40 px-2 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find project…"
                className="h-7 rounded-md border-transparent bg-muted/40 pl-7 pr-2 text-[12px] placeholder:text-muted-foreground/50 focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-0"
              />
            </div>
          </div>
        )}

        <div className="py-1.5">
          <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/50">
            Projects
          </div>
          <div className="max-h-[280px] overflow-y-auto px-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {projectsQuery.isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-7 rounded-md" />
                ))}
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="px-2 py-3 text-[11.5px] text-muted-foreground/60">
                {query.trim() ? 'No projects match' : 'No projects yet'}
              </div>
            ) : (
              filteredProjects.map((project) => {
                const active = project.project_id === activeProjectId;
                const loading = switching && project.project_id !== activeProjectId;
                const relative = formatRelative(project.last_opened_at);
                return (
                  <DropdownMenuItem
                    key={project.project_id}
                    disabled={loading}
                    onSelect={() => switchProject(project)}
                    className={cn(
                      'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 py-0',
                      active && 'bg-muted/60',
                      loading && 'pointer-events-none opacity-60',
                    )}
                  >
                    <EntityAvatar label={project.name} size="xs" />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-[12.5px] font-medium">{project.name}</span>
                      {relative && (
                        <span className="truncate text-[10.5px] text-muted-foreground/60">
                          {relative}
                        </span>
                      )}
                    </div>
                    {loading ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : active ? (
                      <Check className="size-3.5 shrink-0 text-foreground/70" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </div>

        <div className="h-px bg-border/40" />

        <div className="px-1 py-1">
          <DropdownMenuItem
            onSelect={() => {
              close();
              router.push('/projects');
            }}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-0 [&_svg]:!text-muted-foreground/70"
          >
            <ArrowUpRight className="size-3.5" />
            <span className="flex-1 truncate text-[12.5px] font-medium text-foreground/80">
              All projects
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              close();
              router.push('/projects?new=1');
            }}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-0 [&_svg]:!text-muted-foreground/70"
          >
            <Plus className="size-3.5" />
            <span className="flex-1 truncate text-[12.5px] font-medium text-foreground/80">
              New project
            </span>
          </DropdownMenuItem>
        </div>
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
