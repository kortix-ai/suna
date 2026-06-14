'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { ReferralModal } from '@/components/referrals/referral-modal';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { UserAvatar } from '@/components/ui/user-avatar';
import { SidePanelUserSettings } from '@/features/accounts/settings/side-panel-user-settings';
import { DownloadAppsModal } from '@/features/layout/download-apps-modal';
import { SupportModal } from '@/features/layout/support-modal';
import { isBillingEnabled } from '@/lib/config';
import { openExternalRoute } from '@/lib/desktop';
import { type SettingsTabId } from '@/lib/menu-registry';
import { listAccounts } from '@/lib/projects-client';
import { createClient } from '@/lib/supabase/client';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { resetClientState } from '@/lib/utils/reset-client-state';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useReferralDialog } from '@/stores/referral-dialog';
import {
  BookOpen,
  ChevronsUpDown,
  CogOneSolid,
  CreditCardSolid,
  HomeSolid,
} from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Download, LifeBuoy, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';

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
  const sidebar = React.useContext(SidebarContext);
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const { isOpen: referralOpen, closeDialog: closeReferral } = useReferralDialog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const [supportOpen, setSupportOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

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

  const currentAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ?? null;

  const canManageBilling = usePermission(currentAccount?.account_id, 'billing.write').allowed;

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openUserSettings = (tab: SettingsTabId) =>
    deferAfterClose(() => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    });

  const handleLogout = () =>
    deferAfterClose(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      await resetClientState();
      router.push('/auth');
    });

  const trigger =
    variant === 'header' ? (
      <Button
        size="icon"
        className="m-0 border-none p-0 bg-background dark:bg-foreground"
        aria-label={tHardcodedUi.raw('componentsLayoutUserMenu.line142JsxAttrAriaLabelYourMenu')}
      >
        <UserAvatar
          email={user.email}
          name={user.name}
          avatarUrl={user.avatar}
          size="sm"
          className="rounded-none"
        />
      </Button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/user relative h-auto gap-2 rounded-2xl border border-transparent bg-transparent px-1.5 py-1',
          'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
        )}
      >
        <UserAvatar
          email={user.email}
          name={user.name}
          avatarUrl={user.avatar}
          size="sm"
          className="ring-border/40 ring-1"
        />
        <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="text-foreground truncate text-sm font-medium tracking-tight">
            {user.name}
          </span>
          <span className="text-muted-foreground/80 mt-0.5 truncate text-xs">{user.email}</span>
        </div>
        <ChevronsUpDown className="text-muted-foreground/30 ml-auto size-3 shrink-0 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    );

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'sidebar' ? 'start' : 'end'}
        side={variant === 'sidebar' ? (sidebar?.isMobile ? 'bottom' : 'top') : 'bottom'}
        sideOffset={variant === 'sidebar' ? 6 : 8}
        className="w-[256px] space-y-0.5 overflow-hidden"
      >
        {currentAccount && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                deferAfterClose(() => router.push(`/accounts/${currentAccount.account_id}`))
              }
            >
              <EntityAvatar label={currentAccount.name} size="lg" />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-foreground truncate text-sm font-medium">
                  {currentAccount.name}
                </div>
                <div className="text-muted-foreground/70 mt-0.5 truncate text-xs">
                  Account settings
                </div>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem onSelect={() => deferAfterClose(() => router.push('/projects'))}>
          <HomeSolid />
          Home
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() =>
            deferAfterClose(() => {
              if (!openExternalRoute('/docs')) router.push('/docs');
            })
          }
        >
          <BookOpen />
          Docs
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => deferAfterClose(() => setDownloadOpen(true))}>
          <Download />
          Download apps
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => deferAfterClose(() => setSupportOpen(true))}>
          <LifeBuoy />
          Support
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => openUserSettings('general')}>
          <CogOneSolid />

          {tHardcodedUi.raw('componentsLayoutUserMenu.line209JsxAttrLabelUserSettings')}
        </DropdownMenuItem>

        {isBillingEnabled() && canManageBilling && (
          <DropdownMenuItem
            onSelect={() =>
              deferAfterClose(() =>
                useAccountSettingsModalStore.getState().openAccountSettings({ tab: 'billing' }),
              )
            }
          >
            <CreditCardSolid />
            Billing
          </DropdownMenuItem>
        )}

        <div className="focus:bg-foreground/10 focus:text-foreground relative flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-[0.3rem] text-sm transition-colors outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
          Theme
          <ThemeToggle variant="compact" />
        </div>

        <DropdownMenuItem variant="destructive" onSelect={handleLogout}>
          <LogOut />

          {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
        </DropdownMenuItem>
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

      <SidePanelUserSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultTab={settingsTab}
      />
      <SupportModal open={supportOpen} onOpenChange={setSupportOpen} />
      <DownloadAppsModal open={downloadOpen} onOpenChange={setDownloadOpen} />
      <ReferralModal open={referralOpen} onOpenChange={closeReferral} />
    </>
  );
}
