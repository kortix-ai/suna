'use client';

/**
 * UserMenu — the ONE "Account · You" menu.
 *
 * Carries the two identity-shaped concerns that belong together (your
 * personal account *is* you): switching account, account settings + billing,
 * plus user settings, the command menu, theme and log out. "Which project"
 * lives in the sibling <ProjectSwitcher>, not here.
 *
 * Rendered in two places via `variant`:
 *  - `header`  — a compact avatar pill in the top bar (AppHeader).
 *  - `sidebar` — a full-width SidebarFooter widget (project + global shells).
 *
 * Avatar is the design-system <UserAvatar> (people are round); account tiles
 * are <EntityAvatar> (things are square).
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Plus,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
import { isBillingEnabled } from '@/lib/config';
import { transitionFromElement } from '@/lib/view-transition';
import { themeOptions, type SettingsTabId } from '@/lib/menu-registry';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { AccountSettingsModal } from '@/components/settings/account-settings-modal';
import { CreateAccountModal } from '@/components/accounts/create-account-modal';
import type { AccountSettingsTabId } from '@/stores/account-settings-modal-store';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralDialog } from '@/components/referrals/referral-dialog';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';

export type UserMenuVariant = 'header' | 'sidebar';

export interface UserMenuUser {
  name: string;
  email: string;
  avatar: string;
  planName?: string;
}

const isMacUA =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const MOD = isMacUA ? '⌘' : 'Ctrl';

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function UserMenu({
  user,
  variant = 'sidebar',
}: {
  user: UserMenuUser;
  variant?: UserMenuVariant;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Read the context directly (not useSidebar, which throws) so the header
  // variant works where there's no SidebarProvider.
  const sidebar = React.useContext(SidebarContext);
  const { theme, setTheme } = useTheme();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const billingActive = isBillingEnabled();
  const { isOpen: referralOpen, closeDialog: closeReferral } = useReferralDialog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSettingsTab, setAccountSettingsTab] = useState<AccountSettingsTabId>('billing');
  const [createAccountOpen, setCreateAccountOpen] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  // The Account·You menu is mounted on every authenticated page, so it owns
  // the "default selected account" guarantee for the whole app.
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

  const sortedAccounts = useMemo(
    () =>
      [...(accountsQuery.data ?? [])].sort((a, b) => {
        if (a.personal_account && !b.personal_account) return -1;
        if (!a.personal_account && b.personal_account) return 1;
        return (a.name || '').localeCompare(b.name || '');
      }),
    [accountsQuery.data],
  );

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openUserSettings = (tab: SettingsTabId) =>
    deferAfterClose(() => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    });

  const openAccountSettings = (tab: AccountSettingsTabId) =>
    deferAfterClose(() => {
      setAccountSettingsTab(tab);
      setAccountSettingsOpen(true);
    });

  const handleThemeChange = React.useCallback(
    (next: string, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (next === theme) return;
      transitionFromElement(event.currentTarget as HTMLElement, () => setTheme(next));
    },
    [theme, setTheme],
  );

  const handleLogout = () =>
    deferAfterClose(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      clearUserLocalStorage();
      await clearSessionIDBCache();
      router.push('/auth');
    });

  const trigger =
    variant === 'header' ? (
      <button
        type="button"
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border/50 bg-transparent pl-1 pr-2 transition-colors',
          'hover:bg-muted/40 data-[state=open]:bg-muted/50',
        )}
        aria-label="Account and user menu"
      >
        <UserAvatar email={user.email} name={user.name} avatarUrl={user.avatar} size="sm" />
        <ChevronsUpDown className="size-3 text-muted-foreground/60" />
      </button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/user relative h-auto gap-2 rounded-lg border border-transparent bg-transparent px-1.5 py-1',
          'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!px-0',
        )}
      >
        <UserAvatar
          email={user.email}
          name={user.name}
          avatarUrl={user.avatar}
          size="sm"
          className="ring-1 ring-border/40"
        />
        <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate text-[12px] font-medium tracking-tight text-foreground">
            {user.name}
          </span>
          <span className="mt-0.5 truncate text-[10.5px] text-muted-foreground/80">
            {activeAccount?.name ||
              (activeAccount?.personal_account ? 'Personal' : user.email)}
          </span>
        </div>
        <ChevronsUpDown className="ml-auto size-3 shrink-0 text-muted-foreground/30 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    );

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'sidebar' ? 'start' : 'end'}
        side={variant === 'sidebar' ? (sidebar?.isMobile ? 'bottom' : 'top') : 'bottom'}
        sideOffset={variant === 'sidebar' ? 6 : 8}
        className="w-[268px] overflow-hidden rounded-2xl border-border/60 p-0"
      >
        {/* Identity */}
        <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
          <UserAvatar email={user.email} name={user.name} avatarUrl={user.avatar} size="md" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-medium text-foreground">{user.name}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{user.email}</div>
          </div>
          {user.planName && (
            <span className="shrink-0 rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
              {user.planName}
            </span>
          )}
        </div>

        <Divider />

        {/* Account — switch (hover row for that account's settings) + create */}
        <div className="py-1.5">
          <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/50">
            Account
          </div>
          <div className="max-h-[220px] overflow-y-auto px-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {accountsQuery.isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 2 }, (_, i) => (
                  <Skeleton key={i} className="h-7 rounded-md" />
                ))}
              </div>
            ) : (
              sortedAccounts.map((account) => {
                const label = account.name || (account.personal_account ? 'Personal' : 'Account');
                const hint = account.personal_account
                  ? 'Personal'
                  : account.account_role
                    ? capitalize(account.account_role)
                    : null;
                const active = account.account_id === activeAccount?.account_id;
                return (
                  <DropdownMenuItem
                    key={account.account_id}
                    onSelect={() => setSelectedAccountId(account.account_id)}
                    className={cn(
                      'group/acct flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-0',
                      active && 'bg-muted/60',
                    )}
                  >
                    <EntityAvatar label={label} size="xs" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">
                      {label}
                    </span>
                    {hint && (
                      <Badge variant="secondary" size="sm" className="capitalize">
                        {hint}
                      </Badge>
                    )}
                    <button
                      type="button"
                      aria-label={`Settings for ${label}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        deferAfterClose(() => router.push(`/accounts/${account.account_id}`));
                      }}
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover/acct:opacity-100"
                    >
                      <SettingsIcon className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
          <div className="px-1 pt-0.5">
            <ActionRow
              icon={<Plus className="size-3.5" />}
              label="Create new"
              onSelect={() => deferAfterClose(() => setCreateAccountOpen(true))}
            />
          </div>
        </div>

        <Divider />

        {/* Settings */}
        <div className="px-1 py-1">
          {billingActive && (
            <ActionRow
              icon={<CreditCard className="size-3.5" />}
              label="Billing"
              onSelect={() => openAccountSettings('billing')}
            />
          )}
          <ActionRow
            icon={<SettingsIcon className="size-3.5" />}
            label="User settings"
            shortcut={`${MOD},`}
            onSelect={() => openUserSettings('general')}
          />
        </div>

        <Divider />

        {/* Theme */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-foreground/85">Theme</span>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex items-center gap-0.5 rounded-md border border-border/40 bg-muted/30 p-0.5"
            >
              {themeOptions.map((mode) => {
                const Icon = mode.icon;
                const active = theme === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`Theme: ${mode.value}`}
                    onClick={(e) => handleThemeChange(mode.value, e)}
                    className={cn(
                      'flex h-6 w-7 cursor-pointer items-center justify-center rounded-[5px] transition-all duration-150',
                      active
                        ? 'bg-background text-foreground shadow-[0_1px_0_rgba(0,0,0,0.04)]'
                        : 'text-muted-foreground/70 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <Divider />

        <div className="px-1 py-1">
          <ActionRow
            icon={<LogOut className="size-3.5" />}
            label="Log out"
            destructive
            onSelect={handleLogout}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {variant === 'sidebar' ? (
        <SidebarMenu>
          <SidebarMenuItem className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
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
        onCreated={(account: KortixAccount) => {
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
        }}
      />
      <ReferralDialog open={referralOpen} onOpenChange={closeReferral} />
    </>
  );
}

/* ─── Primitives ──────────────────────────────────────────────────────────── */

function Divider() {
  return <div className="h-px bg-border/40" />;
}

function ActionRow({
  icon,
  label,
  shortcut,
  destructive,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      variant={destructive ? 'destructive' : 'default'}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-0 text-left',
        '[&_svg:not([class*=size-])]:size-3.5',
        destructive
          ? '[&_svg]:!text-red-500/70 dark:[&_svg]:!text-red-400/70'
          : '[&_svg]:!text-muted-foreground/70',
      )}
    >
      {icon}
      <span className="flex-1 truncate text-[12.5px] font-medium leading-tight">{label}</span>
      {shortcut && (
        <kbd
          className={cn(
            'rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
            destructive ? 'text-red-500/70' : 'text-muted-foreground/70',
          )}
        >
          {shortcut}
        </kbd>
      )}
    </DropdownMenuItem>
  );
}
