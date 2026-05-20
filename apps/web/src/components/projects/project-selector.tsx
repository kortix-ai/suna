'use client';

/**
 * ProjectSelector — the sidebar-header switcher for accounts + projects.
 *
 * Vercel-style design language:
 *  - Restrained trigger: no permanent border; border + bg appear on hover / open.
 *  - Monogram squares (rounded-md) with deterministic, muted accent tints so
 *    the user can recognise a project at a glance without rainbow gradients.
 *  - Sectioned dropdown with tiny uppercase labels and a tight 8px row height.
 *  - Quick actions at the bottom with kbd hints, right-aligned, low contrast.
 *  - Active row uses `bg-muted/50` — checkmarks are reserved for ambiguous lists
 *    (accounts) where the active item is otherwise indistinguishable.
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronsUpDown,
  Plus,
  Search,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarMenu,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import {
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
} from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  useIsSwitchingProject,
  useProjectSwitchStore,
} from '@/stores/project-switch-store';

/* ─── Visual helpers ──────────────────────────────────────────────────────── */

// Single restrained tone for every monogram — no rainbow tints. The square
// reads as "an avatar slot" without competing with the project name for
// attention. Matches Vercel's neutral team/project glyphs.
const MONOGRAM_CLASS = 'bg-foreground/[0.06] text-foreground/80 dark:bg-foreground/[0.08]';

function monogram(name: string) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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
  return new Date(input).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ─── Component ───────────────────────────────────────────────────────────── */

export function ProjectSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useProjectSwitchStore((s) => s.beginSwitch);
  const endSwitch = useProjectSwitchStore((s) => s.endSwitch);
  const switching = useIsSwitchingProject();

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!menuOpen) setQuery('');
  }, [menuOpen]);

  const activeProjectId = pathname?.startsWith('/projects/') ? params?.id : undefined;

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return;
    if (!selectedAccountId || !accounts.find((a) => a.account_id === selectedAccountId)) {
      setSelectedAccountId(accounts[0].account_id);
    }
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);

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

  const accountName =
    activeAccount?.name || (activeAccount?.personal_account ? 'Personal' : 'Workspace');
  const projectName = activeProject?.name ?? 'Select project';

  const sortedAccounts = useMemo(
    () =>
      [...(accountsQuery.data ?? [])].sort((a, b) => {
        if (a.personal_account && !b.personal_account) return -1;
        if (!a.personal_account && b.personal_account) return 1;
        return (a.name || '').localeCompare(b.name || '');
      }),
    [accountsQuery.data],
  );

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

  const switchAccount = (account: KortixAccount) => {
    setSelectedAccountId(account.account_id);
  };

  const switchProject = (project: KortixProject) => {
    if (project.project_id === activeProjectId) {
      close();
      return;
    }
    beginSwitch(project.project_id);
    close();
    router.push(`/projects/${project.project_id}`);
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Switch project · ${projectName}`}
              className={cn(
                'group/ws flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors',
                'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
                menuOpen && 'bg-sidebar-accent/60',
                'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!px-0',
              )}
            >
              <KortixLogo variant="symbol" size={16} className="flex-shrink-0" />
              <span className="text-muted-foreground/40 group-data-[collapsible=icon]:hidden">/</span>
              <span className="min-w-0 flex-1 truncate font-sans text-[0.875rem] font-medium tracking-[-0.005em] text-foreground group-data-[collapsible=icon]:hidden">
                {projectName}
              </span>
              <ChevronsUpDown
                className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover/ws:text-foreground group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={6}
            className={cn(
              // Match the trigger's exact width so the dropdown reads as
              // "the same surface expanding downward", not a floating panel.
              'w-(--radix-dropdown-menu-trigger-width) overflow-hidden rounded-xl border-border/60 p-0 shadow-none',
            )}
          >
            {showSearch && (
              <div className="border-b border-border/40 px-2 py-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find project…"
                    className="h-7 rounded-md border-transparent bg-muted/40 pl-7 pr-2 text-[12px] placeholder:text-muted-foreground/50 focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-0"
                  />
                </div>
              </div>
            )}

            {/* ─── Accounts ──────────────────────────────────────────────── */}
            <Section label="Account">
              {accountsQuery.isLoading ? (
                <LoadingRows count={1} />
              ) : (
                sortedAccounts.map((account) => (
                  <AccountRow
                    key={account.account_id}
                    account={account}
                    active={account.account_id === activeAccount?.account_id}
                    onSelect={() => switchAccount(account)}
                  />
                ))
              )}
            </Section>

            <Divider />

            {/* ─── Projects ──────────────────────────────────────────────── */}
            <Section
              label={
                <span className="flex items-center justify-between">
                  <span>Projects</span>
                  {!showSearch && allProjectsSorted.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                      {allProjectsSorted.length}
                    </span>
                  )}
                </span>
              }
            >
              <div className="max-h-[260px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                {projectsQuery.isLoading ? (
                  <LoadingRows count={3} />
                ) : filteredProjects.length === 0 ? (
                  <EmptyState
                    text={query.trim() ? 'No projects match' : 'No projects yet'}
                  />
                ) : (
                  filteredProjects.map((project) => (
                    <ProjectRow
                      key={project.project_id}
                      project={project}
                      active={project.project_id === activeProjectId}
                      loading={switching && project.project_id !== activeProjectId}
                      onSelect={() => switchProject(project)}
                    />
                  ))
                )}
              </div>
            </Section>

            <Divider />

            {/* ─── Footer actions ────────────────────────────────────────── */}
            <div className="px-1 py-1">
              <FooterAction
                icon={<ArrowUpRight className="size-3.5" />}
                label="All projects"
                onSelect={() => {
                  close();
                  router.push('/projects');
                }}
              />
              <FooterAction
                icon={<Plus className="size-3.5" />}
                label="New project"
                onSelect={() => {
                  close();
                  router.push('/projects?new=1');
                }}
              />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/* ─── Primitives ──────────────────────────────────────────────────────────── */

function Divider() {
  return <div className="h-px bg-border/40" />;
}

function Section({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1.5">
      <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/50">
        {label}
      </div>
      <div className="px-1">{children}</div>
    </div>
  );
}

function AccountRow({
  account,
  active,
  onSelect,
}: {
  account: KortixAccount;
  active: boolean;
  onSelect: () => void;
}) {
  const label = account.name || (account.personal_account ? 'Personal' : 'Account');
  const hint = account.personal_account
    ? 'Personal'
    : account.account_role
      ? capitalize(account.account_role)
      : null;

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-0',
        active && 'bg-muted/60',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[9px] font-semibold tracking-tight',
          MONOGRAM_CLASS,
        )}
      >
        {monogram(label)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">
        {label}
      </span>
      {hint && (
        <span className="shrink-0 rounded-sm bg-muted/60 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground/70">
          {hint}
        </span>
      )}
      {active && <ActiveDot />}
    </DropdownMenuItem>
  );
}

function ProjectRow({
  project,
  active,
  loading,
  onSelect,
}: {
  project: KortixProject;
  active: boolean;
  loading: boolean;
  onSelect: () => void;
}) {
  const relative = formatRelative(project.last_opened_at);

  return (
    <DropdownMenuItem
      disabled={loading}
      onSelect={onSelect}
      className={cn(
        'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 py-0',
        active && 'bg-muted/60',
        loading && 'pointer-events-none opacity-60',
      )}
    >
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tracking-tight',
          MONOGRAM_CLASS,
        )}
      >
        {monogram(project.name)}
      </span>
      <div className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-[12.5px] font-medium">{project.name}</span>
        {relative && (
          <span className="truncate text-[10.5px] text-muted-foreground/60">
            {relative}
          </span>
        )}
      </div>
      {active && <ActiveDot />}
    </DropdownMenuItem>
  );
}

function FooterAction({
  icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-0 [&_svg]:!text-muted-foreground/70"
    >
      {icon}
      <span className="flex-1 truncate text-[12.5px] font-medium text-foreground/80">
        {label}
      </span>
      {shortcut && (
        <kbd className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">
          {shortcut}
        </kbd>
      )}
    </DropdownMenuItem>
  );
}

function ActiveDot() {
  return (
    <span className="shrink-0">
      <span className="block h-1.5 w-1.5 rounded-full bg-foreground/70" />
    </span>
  );
}

function LoadingRows({ count = 2 }: { count?: number }) {
  return (
    <div className="space-y-1 px-1 py-1">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-7 rounded-md" />
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-2 py-3 text-[11.5px] text-muted-foreground/60">{text}</div>
  );
}
