'use client';

/**
 * UserMenu — sidebar-footer identity widget.
 *
 * Vercel-style design language:
 *  - Ghost trigger: no permanent border; subtle bg appears on hover / open.
 *  - Tight identity row inside the dropdown (name + email, no fake avatar).
 *  - Action rows with right-aligned kbd hints — discoverable shortcuts.
 *  - Theme as a segmented control on its own row, sized like the actions.
 *  - Log out lives below a divider, low-contrast destructive accent.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronsUpDown,
  Command as CommandIcon,
  CreditCard,
  LogOut,
  Settings as SettingsIcon,
  User as UserIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
import { isBillingEnabled } from '@/lib/config';
import { transitionFromElement } from '@/lib/view-transition';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralDialog } from '@/components/referrals/referral-dialog';
import { themeOptions, type SettingsTabId } from '@/lib/menu-registry';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface UserMenuProps {
  user: {
    name: string;
    email: string;
    avatar: string;
    planName?: string;
  };
}

type SettingsTab = SettingsTabId;

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

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

const isMacUA =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const MOD = isMacUA ? '⌘' : 'Ctrl';

/* ─── Component ───────────────────────────────────────────────────────────── */

export function UserMenu({ user }: UserMenuProps) {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const billingActive = isBillingEnabled();
  const { theme, setTheme } = useTheme();
  const {
    isOpen: isReferralDialogOpen,
    closeDialog: closeReferralDialog,
  } = useReferralDialog();

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [showSettingsModal, setShowSettingsModal] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>('general');

  // Defer modal/route side-effects to the next frame so Radix can finish its
  // dropdown close + focus-return choreography first. Without this you get a
  // brief flicker because the trigger reclaims focus right as the modal grabs
  // focus, then the modal grabs focus back. One frame of separation kills it.
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openSettings = (tab: SettingsTab) => {
    deferAfterClose(() => {
      setSettingsTab(tab);
      setShowSettingsModal(true);
    });
  };

  const handleThemeChange = React.useCallback(
    (next: string, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (next === theme) return;
      transitionFromElement(event.currentTarget as HTMLElement, () => setTheme(next));
    },
    [theme, setTheme],
  );

  const handleLogout = () => {
    deferAfterClose(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      clearUserLocalStorage();
      await clearSessionIDBCache();
      router.push('/auth');
    });
  };

  const handleCommandPalette = () => {
    deferAfterClose(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          metaKey: isMacUA,
          ctrlKey: !isMacUA,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className={cn(
                  'group/user relative h-auto gap-2 rounded-lg px-1.5 py-1',
                  'border border-transparent bg-transparent',
                  'hover:bg-sidebar-accent/60',
                  'data-[state=open]:bg-sidebar-accent',
                  'group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!px-0',
                )}
              >
                <Avatar className="h-6 w-6 shrink-0 rounded-full ring-1 ring-border/40">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-full bg-muted text-[9.5px] font-semibold text-muted-foreground">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-[12px] font-medium text-foreground tracking-tight">
                    {user.name}
                  </span>
                  <span className="truncate text-[10.5px] text-muted-foreground/80 mt-0.5">
                    {user.email}
                  </span>
                </div>
                <ChevronsUpDown
                  className={cn(
                    'ml-auto size-3 shrink-0 text-muted-foreground/30',
                    'transition-colors duration-150',
                    'group-hover/user:text-muted-foreground/70 group-data-[state=open]/user:text-muted-foreground/70',
                    'group-data-[collapsible=icon]:hidden',
                  )}
                />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              side={isMobile ? 'bottom' : 'top'}
              sideOffset={6}
              className={cn(
                // Same width as the trigger; no custom shadow so it sits flush
                // with the sidebar and mirrors the ProjectSelector dropdown.
                'w-(--radix-dropdown-menu-trigger-width) overflow-hidden rounded-xl border-border/60 p-0 shadow-none',
              )}
            >
              {/* ─── Identity ─────────────────────────────────────────── */}
              <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
                <Avatar className="h-8 w-8 shrink-0 rounded-full ring-1 ring-border/40">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[13px] font-medium text-foreground">
                    {user.name}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                    {user.email}
                  </div>
                </div>
                {user.planName && (
                  <span className="shrink-0 rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
                    {user.planName}
                  </span>
                )}
              </div>

              <Divider />

              {/* ─── Account actions ──────────────────────────────────── */}
              <div className="px-1 py-1">
                <ActionRow
                  icon={<UserIcon className="size-3.5" />}
                  label="Account"
                  onSelect={() => openSettings('general')}
                />
                {billingActive && (
                  <ActionRow
                    icon={<CreditCard className="size-3.5" />}
                    label="Billing"
                    onSelect={() => openSettings('billing')}
                  />
                )}
                <ActionRow
                  icon={<SettingsIcon className="size-3.5" />}
                  label="Settings"
                  shortcut={`${MOD},`}
                  onSelect={() => openSettings('general')}
                />
                <ActionRow
                  icon={<CommandIcon className="size-3.5" />}
                  label="Command menu"
                  shortcut={`${MOD}K`}
                  onSelect={handleCommandPalette}
                />
              </div>

              <Divider />

              {/* ─── Theme switcher ───────────────────────────────────── */}
              <div className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] font-medium text-foreground/85">
                    Theme
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="Theme"
                    className="flex items-center gap-0.5 rounded-md border border-border/40 bg-muted/30 p-0.5"
                  >
                    {themeOptions.map((mode) => {
                      const Icon = mode.icon;
                      const isActive = theme === mode.value;
                      return (
                        <button
                          key={mode.value}
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          aria-label={`Theme: ${mode.value}`}
                          onClick={(event) => handleThemeChange(mode.value, event)}
                          className={cn(
                            'flex h-6 w-7 cursor-pointer items-center justify-center rounded-[5px] transition-all duration-150',
                            isActive
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

              {/* ─── Log out ──────────────────────────────────────────── */}
              <div className="px-1 py-1">
                <ActionRow
                  icon={<LogOut className="size-3.5" />}
                  label="Log out"
                  onSelect={handleLogout}
                  destructive
                />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <UserSettingsModal
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        defaultTab={settingsTab}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />

      <ReferralDialog open={isReferralDialogOpen} onOpenChange={closeReferralDialog} />
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
  // Render as a Radix DropdownMenuItem so Radix owns the close-on-select
  // and focus-return choreography — this is what kills the post-click
  // flicker we got from rolling our own <button>.
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
      <span className="flex-1 truncate text-[12.5px] font-medium leading-tight">
        {label}
      </span>
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
