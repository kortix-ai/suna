'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronsUpDown,
  CreditCard,
  Settings as SettingsIcon,
} from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { createClient } from '@/lib/supabase/client';
import { useTheme } from 'next-themes';
import { isBillingEnabled } from '@/lib/config';
import { transitionFromElement } from '@/lib/view-transition';

import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';

import { useTranslations } from 'next-intl';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralDialog } from '@/components/referrals/referral-dialog';
import {
  themeOptions,
  type SettingsTabId,
} from '@/lib/menu-registry';

// ============================================================================
// Types
// ============================================================================

interface UserMenuProps {
  user: {
    name: string;
    email: string;
    avatar: string;
    planName?: string;
  };
}

type SettingsTab = SettingsTabId;

// ============================================================================
// Component
// ============================================================================

export function UserMenu({ user }: UserMenuProps) {
  const t = useTranslations('sidebar');
  const router = useRouter();
  const { isMobile } = useSidebar();
  const billingActive = isBillingEnabled();
  const [showSettingsModal, setShowSettingsModal] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>('general');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { isOpen: isReferralDialogOpen, openDialog: openReferralDialog, closeDialog: closeReferralDialog } = useReferralDialog();
  const { theme, setTheme } = useTheme();

  const handleThemeChange = React.useCallback((newTheme: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (newTheme === theme) return;
    transitionFromElement(e.currentTarget as HTMLElement, () => setTheme(newTheme));
  }, [theme, setTheme]);


  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setShowSettingsModal(true);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) =>
    name.split(' ').map((p) => p.charAt(0)).join('').toUpperCase().substring(0, 2);

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className='bg-muted/40 hover:bg-muted/20 rounded-2xl border'
              >
                <Avatar className="h-8 w-8 rounded-full flex-shrink-0">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-full text-xs">{getInitials(user.name)}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col justify-center flex-1 min-w-0 gap-0.5 group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-medium text-[13px] leading-tight">{user.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground leading-tight">{user.email}</span>
                </div>
                <ChevronsUpDown className="ml-auto size-3.5 flex-shrink-0 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
              side={isMobile ? 'bottom' : 'top'}
              align="start"
              sideOffset={6}
            >
              {/* Account-only menu. Workspace switching lives exclusively in
                  the sidebar-header switcher (Slack/Linear style) so there's
                  one obvious place for "what workspace am I in / switch". */}
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => openSettings('billing')} className="cursor-pointer">
                  <CreditCard />
                  <span>Billing</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openSettings('general')} className="cursor-pointer">
                  <SettingsIcon />
                  <span>Settings</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="my-1" />

              {/* Theme toggle + Log out */}
              <div className="flex items-center justify-between px-1 py-0.5">
                <div className="flex gap-0.5 p-0.5 bg-muted/50 rounded-md">
                  {themeOptions.map((mode) => {
                    const Icon = mode.icon;
                    const isActive = theme === mode.value;
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={(e) => handleThemeChange(mode.value, e)}
                        className={cn('p-1 rounded-[4px] transition-colors duration-150 cursor-pointer',
                          isActive
                            ? 'bg-background text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <Icon className="size-3" />
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-[11.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer px-2 py-1"
                >
                  Log out
                </button>
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

      <ReferralDialog
        open={isReferralDialogOpen}
        onOpenChange={closeReferralDialog}
      />
    </>
  );
}
