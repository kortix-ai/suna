'use client';

/**
 * WorkspaceMenu — the single widget that carries identity + workspace
 * context + settings. Sits at the bottom of the project sidebar and in
 * the top-right of the bare AppHeader.
 *
 * Trigger:  avatar + user name + workspace subtitle.
 * Dropdown: identity → account list → project list → settings → theme/logout.
 *
 * Visual language is intentionally restrained — single-line rows, no
 * boxed sections, no row avatars. Hierarchy comes from spacing and
 * weight, not borders.
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams, usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Plus,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { useTheme } from 'next-themes';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
import { themeOptions } from '@/lib/menu-registry';
import { transitionFromElement } from '@/lib/view-transition';
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
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { AccountSettingsModal } from '@/components/settings/account-settings-modal';
import { CreateAccountModal } from '@/components/accounts/create-account-modal';
import type { AccountSettingsTabId } from '@/stores/account-settings-modal-store';
import type { SettingsTabId } from '@/lib/menu-registry';

type WorkspaceUser = {
  name: string;
  email: string;
  avatar: string;
};

export type WorkspaceMenuVariant = 'sidebar' | 'header';

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function initials(name: string) {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  );
}

function useSidebarSafe() {
  return React.useContext(SidebarContext);
}

/* ─── Component ───────────────────────────────────────────────────────── */

export function WorkspaceMenu({
  user,
  variant = 'sidebar',
}: {
  user: WorkspaceUser;
  variant?: WorkspaceMenuVariant;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const queryClient = useQueryClient();
  const sidebar = useSidebarSafe();
  const { theme, setTheme } = useTheme();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useProjectSwitchStore((s) => s.beginSwitch);
  const endSwitch = useProjectSwitchStore((s) => s.endSwitch);
  const switching = useIsSwitchingProject();

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSettingsTab, setAccountSettingsTab] = useState<AccountSettingsTabId>('billing');
  const [createAccountOpen, setCreateAccountOpen] = useState(false);

  const onProjectsRoute = pathname?.startsWith('/projects') ?? false;
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

  /* ─── Derived strings ─── */

  const accountName =
    activeAccount?.name || (activeAccount?.personal_account ? 'Personal' : 'Workspace');
  const projectName = activeProject?.name;
  const subtitle = projectName ? `${accountName} · ${projectName}` : accountName;
  const userInitials = initials(user.name || 'User');

  /* ─── Sorted data ─── */

  const sortedAccounts = useMemo(
    () =>
      [...(accountsQuery.data ?? [])].sort((a, b) => {
        if (a.personal_account && !b.personal_account) return -1;
        if (!a.personal_account && b.personal_account) return 1;
        return (a.name || '').localeCompare(b.name || '');
      }),
    [accountsQuery.data],
  );

  const recentProjects = useMemo(() => {
    const list = [...(projectsQuery.data ?? [])];
    list.sort((a, b) => {
      const at = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
      const bt = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
      return bt - at;
    });
    return list.slice(0, 5);
  }, [projectsQuery.data]);

  /* ─── Handlers ─── */

  const close = () => setMenuOpen(false);

  const handleThemeChange = (next: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (next === theme) return;
    transitionFromElement(event.currentTarget as HTMLElement, () => setTheme(next));
  };

  const openSettings = (tab: SettingsTabId) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    close();
  };

  const openAccountSettings = (tab: AccountSettingsTabId = 'billing') => {
    setAccountSettingsTab(tab);
    setAccountSettingsOpen(true);
    close();
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    await clearSessionIDBCache();
    router.push('/auth');
  };

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

  /* ─── Trigger ─── */

  const trigger =
    variant === 'sidebar' ? (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/workspace h-auto gap-3 rounded-xl border border-border/50 bg-card/40 py-2 pl-2 pr-2.5',
          'transition-all hover:bg-card hover:border-border/80 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
          'data-[state=open]:bg-card data-[state=open]:border-border/80 data-[state=open]:shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
          'group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!border-transparent group-data-[collapsible=icon]:!bg-transparent group-data-[collapsible=icon]:!shadow-none',
        )}
      >
        <Avatar className="h-8 w-8 shrink-0 ring-1 ring-border/60">
          <AvatarImage src={user.avatar} alt={user.name} />
          <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
            {userInitials}
          </AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate text-[13px] font-semibold text-foreground tracking-tight">
            {user.name}
          </span>
          <span className="truncate text-[11px] text-muted-foreground/90 mt-0.5">
            {subtitle}
          </span>
        </div>
        <ChevronsUpDown
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground/40 transition-colors',
            'group-hover/workspace:text-muted-foreground/80',
            'group-data-[collapsible=icon]:hidden',
          )}
        />
      </SidebarMenuButton>
    ) : (
      <button
        type="button"
        className={cn(
          'flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border/50 bg-transparent pl-1 pr-3 transition-colors hover:bg-muted/40',
          'data-[state=open]:bg-muted/50',
        )}
      >
        <Avatar className="h-7 w-7 shrink-0">
          <AvatarImage src={user.avatar} alt={user.name} />
          <AvatarFallback className="text-[10px] font-semibold">{userInitials}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-[18ch] truncate text-[12.5px] font-medium text-foreground sm:inline">
          {subtitle}
        </span>
        <ChevronsUpDown className="size-3 text-muted-foreground/60" />
      </button>
    );

  /* ─── Render ─── */

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'sidebar' ? 'start' : 'end'}
        side={variant === 'sidebar' ? (sidebar?.isMobile ? 'bottom' : 'top') : 'bottom'}
        sideOffset={8}
        className="w-[280px] overflow-hidden rounded-xl border-border/50 p-0 shadow-2xl shadow-black/[0.08]"
      >
        {/* Identity */}
        <div className="px-3.5 pt-3.5 pb-2.5">
          <div className="truncate text-[13px] font-medium text-foreground leading-tight">
            {user.name}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground leading-tight">
            {user.email}
          </div>
        </div>

        <Divider />

        {/* Account */}
        <Section label="Account">
          {accountsQuery.isLoading ? (
            <LoadingRows />
          ) : (
            sortedAccounts.map((account) => (
              <Row
                key={account.account_id}
                label={account.name || (account.personal_account ? 'Personal' : 'Account')}
                hint={
                  account.personal_account
                    ? 'Personal'
                    : account.account_role
                      ? capitalize(account.account_role)
                      : null
                }
                active={account.account_id === activeAccount?.account_id}
                onSelect={() => switchAccount(account)}
              />
            ))
          )}
          <QuietAction
            label="Account settings"
            icon={<SettingsIcon className="h-3 w-3" />}
            onSelect={() => openAccountSettings('billing')}
          />
          <QuietAction
            label="Billing"
            icon={<CreditCard className="h-3 w-3" />}
            onSelect={() => openAccountSettings('billing')}
          />
          <QuietAction
            label="Manage accounts"
            icon={<Users className="h-3 w-3" />}
            onSelect={() => {
              close();
              router.push('/accounts');
            }}
          />
          <QuietAction
            label="Create account"
            icon={<Plus className="h-3 w-3" />}
            onSelect={() => {
              close();
              setCreateAccountOpen(true);
            }}
          />
        </Section>

        {/* Project — only when scoped to /projects */}
        {onProjectsRoute && (
          <>
            <Divider />
            <Section label="Project">
              {projectsQuery.isLoading ? (
                <LoadingRows />
              ) : recentProjects.length === 0 ? (
                <div className="px-3.5 py-2 text-[11.5px] text-muted-foreground/70">
                  No projects yet
                </div>
              ) : (
                recentProjects.map((project) => (
                  <Row
                    key={project.project_id}
                    label={project.name}
                    active={project.project_id === activeProjectId}
                    loading={switching && project.project_id !== activeProjectId}
                    onSelect={() => switchProject(project)}
                  />
                ))
              )}
              <QuietAction
                label="Browse all projects"
                icon={<ArrowUpRight className="h-3 w-3" />}
                onSelect={() => {
                  close();
                  router.push('/projects');
                }}
              />
              <QuietAction
                label="Create new project"
                icon={<Plus className="h-3 w-3" />}
                onSelect={() => {
                  close();
                  router.push('/projects?new=1');
                }}
              />
            </Section>
          </>
        )}

        <Divider />

        {/* User settings */}
        <div className="py-1">
          <ActionRow
            label="User settings"
            icon={<SettingsIcon className="h-3.5 w-3.5" />}
            onSelect={() => openSettings('general')}
          />
        </div>

        <Divider />

        {/* Theme + Log out */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex gap-0.5 rounded-full border border-border/40 p-0.5">
            {themeOptions.map((mode) => {
              const Icon = mode.icon;
              const isActive = theme === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  onClick={(event) => handleThemeChange(mode.value, event)}
                  aria-label={`Theme: ${mode.value}`}
                  className={cn(
                    'cursor-pointer rounded-full p-1 transition-colors',
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground/70 hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <LogOut className="h-3 w-3" />
            Log out
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {variant === 'sidebar' ? (
        <SidebarMenu>
          <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
            {dropdown}
          </SidebarMenuItem>
        </SidebarMenu>
      ) : (
        dropdown
      )}

      <UserSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultTab={settingsTab}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />

      <AccountSettingsModal
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
        defaultTab={accountSettingsTab}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />

      <CreateAccountModal
        open={createAccountOpen}
        onOpenChange={setCreateAccountOpen}
        onCreated={(account) => {
          queryClient.setQueryData<KortixAccount[]>(['accounts'], (accounts = []) => {
            if (accounts.some((item) => item.account_id === account.account_id)) {
              return accounts;
            }
            return [...accounts, account];
          });
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
        }}
      />
    </>
  );
}

/* ─── Primitives ──────────────────────────────────────────────────────── */

function Divider() {
  return <div className="h-px bg-border/40" />;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-3.5 pt-1 pb-0.5 text-[10.5px] font-medium text-muted-foreground/60">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  active,
  muted,
  loading,
  trailing,
  onSelect,
}: {
  label: string;
  hint?: string | null;
  active?: boolean;
  muted?: boolean;
  loading?: boolean;
  trailing?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={loading}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-3.5 text-left transition-colors',
        active ? 'text-foreground' : muted ? 'text-muted-foreground' : 'text-foreground/85',
        'hover:bg-muted/50 hover:text-foreground',
        loading && 'pointer-events-none opacity-60',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">
        {label}
      </span>
      {hint && (
        <span className="shrink-0 text-[10.5px] text-muted-foreground/60">{hint}</span>
      )}
      {trailing}
      {active && <Check className="h-3.5 w-3.5 shrink-0 text-foreground/70" />}
    </button>
  );
}

function ActionRow({
  label,
  icon,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 px-3.5 text-left text-[12.5px] font-medium text-foreground/85 transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <span className="text-muted-foreground/70">{icon}</span>
      {label}
    </button>
  );
}

/**
 * Secondary action that lives at the foot of a Section — visually quieter
 * than a primary list row so the active item still reads first.
 */
function QuietAction({
  label,
  icon,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-7 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-[11.5px] text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
    >
      <span className="text-muted-foreground/50">{icon}</span>
      {label}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-1 px-3.5 py-1">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-6 rounded-md" />
      ))}
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
