'use client';

import { useTranslations } from 'next-intl';
/**
 * UserMenu — the ONE "you" menu.
 *
 * Pure identity: who you are, a Home shortcut, user settings, theme, and log
 * out. "Which account" lives in the sibling <AccountSwitcher> (the breadcrumb),
 * "which project" in <ProjectSwitcher> — neither belongs here.
 *
 * Because this menu is mounted on every authenticated page, it still owns the
 * one cross-cutting account concern: guaranteeing a default selected account
 * for the whole app (the AccountSwitcher only renders in the header).
 *
 * Rendered in two places via `variant`:
 *  - `header`  — a compact avatar pill in the top bar (AppHeader).
 *  - `sidebar` — a full-width SidebarFooter widget (project + global shells).
 *
 * Avatar is the design-system <UserAvatar> (people are round; the supabase
 * profile picture loads when present, neutral initials otherwise).
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronsUpDown,
  Home,
  LogOut,
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
import { UserAvatar } from '@/components/ui/user-avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
import { transitionFromElement } from '@/lib/view-transition';
import { themeOptions, type SettingsTabId } from '@/lib/menu-registry';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralDialog } from '@/components/referrals/referral-dialog';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@/lib/projects-client';

export type UserMenuVariant = 'header' | 'sidebar';

export interface UserMenuUser {
  name: string;
  email: string;
  avatar: string;
  planName?: string;
}

export function UserMenu({
  user,
  variant = 'sidebar',
}: {
  user: UserMenuUser;
  variant?: UserMenuVariant;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  // Read the context directly (not useSidebar, which throws) so the header
  // variant works where there's no SidebarProvider.
  const sidebar = React.useContext(SidebarContext);
  const { theme, setTheme } = useTheme();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const { isOpen: referralOpen, closeDialog: closeReferral } = useReferralDialog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');

  // Mounted on every authenticated page, so this menu owns the "default
  // selected account" guarantee for the whole app. The account *switcher*
  // (breadcrumb) only renders in the header.
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

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openUserSettings = (tab: SettingsTabId) =>
    deferAfterClose(() => {
      setSettingsTab(tab);
      setSettingsOpen(true);
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
        aria-label={tHardcodedUi.raw('componentsLayoutUserMenu.line142JsxAttrAriaLabelYourMenu')}
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
          <span className="truncate text-sm font-medium tracking-tight text-foreground">
            {user.name}
          </span>
          <span className="mt-0.5 truncate text-xs text-muted-foreground/80">
            {user.email}
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
        className="w-[256px] overflow-hidden rounded-2xl border-border/60 p-0"
      >
        {/* Identity */}
        <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
          <UserAvatar email={user.email} name={user.name} avatarUrl={user.avatar} size="md" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">{user.email}</div>
          </div>
          {user.planName && (
            <Badge size="sm" variant="secondary" className="shrink-0 font-semibold uppercase tracking-[0.06em]">
              {user.planName}
            </Badge>
          )}
        </div>

        <Divider />

        {/* One action group — kept divider-light by design. */}
        <div className="p-1">
          <ActionRow
            icon={<Home className="size-3.5" />}
            label="Home"
            onSelect={() => deferAfterClose(() => router.push('/projects'))}
          />
          <ActionRow
            icon={<SettingsIcon className="size-3.5" />}
            label={tHardcodedUi.raw('componentsLayoutUserMenu.line209JsxAttrLabelUserSettings')}
            onSelect={() => openUserSettings('general')}
          />

          {/* Theme — inline segmented control, pill radius (on-brand). */}
          <div className="flex h-8 items-center justify-between rounded-lg px-2">
            <span className="text-sm font-medium text-foreground/85">Theme</span>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex items-center gap-0.5 rounded-full border border-border/50 bg-muted/40 p-0.5"
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
                      'flex h-6 w-7 cursor-pointer items-center justify-center rounded-full transition-all duration-150',
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

          <ActionRow
            icon={<LogOut className="size-3.5" />}
            label={tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
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
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-0 text-left',
        '[&_svg:not([class*=size-])]:size-3.5 [&_svg]:!text-muted-foreground/70',
      )}
    >
      {icon}
      <span className="flex-1 truncate text-sm font-medium leading-tight">{label}</span>
      {shortcut && (
        <kbd className="rounded bg-muted/60 px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground/70">
          {shortcut}
        </kbd>
      )}
    </DropdownMenuItem>
  );
}
