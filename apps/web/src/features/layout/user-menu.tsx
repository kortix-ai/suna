'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { ReferralModal } from '@/components/referrals/referral-modal';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { BookOpen, CogOne, CreditCard, HomeSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Download, LifeBuoy, LogOut, Store } from 'lucide-react';
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

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

  const openLogoutConfirm = () => deferAfterClose(() => setLogoutConfirmOpen(true));

  const performLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    await resetClientState();
    router.push('/auth');
  };

  const trigger =
    variant === 'header' ? (
      <Button
        variant="transparent"
        size="icon"
        className="m-0 size-8 overflow-hidden rounded-sm p-0"
      >
        <UserAvatar
          email={user.email}
          name={user?.name}
          avatarUrl={user.avatar}
          size="sm"
          className="size-full rounded-sm"
        />
      </Button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/user relative gap-2 px-2.5 py-1',
          // 'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'relative flex cursor-pointer items-center gap-2 rounded-md px-2 transition-colors duration-150',
          'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
        )}
      >
        <UserAvatar
          email={user.email}
          name={user.name}
          avatarUrl={user.avatar}
          size="md"
          className="border-border border"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start justify-start space-y-0 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="text-foreground truncate text-sm font-medium tracking-tight">
            {user.name}
          </span>
          <span className="text-muted-foreground/80 truncate text-xs">{user.email}</span>
        </div>
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
              onClick={() =>
                deferAfterClose(() => router.push(`/accounts/${currentAccount.account_id}`))
              }
            >
              <UserAvatar
                email={user.email}
                name={user.name}
                avatarUrl={user.avatar}
                size="lg"
                className="border-border border"
              />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-foreground truncate text-sm font-medium">
                  {currentAccount.name}
                </div>
                <div className="text-muted-foreground/70 mt-0.5 truncate text-xs">
                  {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextAccountSettings007162f5')}
                </div>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem onClick={() => deferAfterClose(() => router.push('/projects'))}>
          <HomeSolid />
          Home
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => deferAfterClose(() => router.push('/marketplace'))}>
          <Store />
          Marketplace
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() =>
            deferAfterClose(() => {
              if (!openExternalRoute('/docs')) router.push('/docs');
            })
          }
        >
          <BookOpen />
          Docs
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => deferAfterClose(() => setDownloadOpen(true))}>
          <Download />
          {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextDownloadApps2765d8e7')}
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => deferAfterClose(() => setSupportOpen(true))}>
          <LifeBuoy />
          Support
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => openUserSettings('general')}>
          <CogOne />

          {tHardcodedUi.raw('componentsLayoutUserMenu.line209JsxAttrLabelUserSettings')}
        </DropdownMenuItem>

        {isBillingEnabled() && canManageBilling && (
          <DropdownMenuItem
            onClick={() =>
              deferAfterClose(() =>
                useAccountSettingsModalStore.getState().openAccountSettings({ tab: 'billing' }),
              )
            }
          >
            <CreditCard />
            Billing
          </DropdownMenuItem>
        )}

        <DropdownMenuItem variant="destructive" onClick={openLogoutConfirm}>
          <LogOut />

          {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="focus:bg-foreground/10 focus:text-foreground relative flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-[0.3rem] text-sm transition-colors outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
          Theme
          <ThemeToggle variant="compact" />
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

      <SidePanelUserSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultTab={settingsTab}
      />
      <SupportModal open={supportOpen} onOpenChange={setSupportOpen} />
      <DownloadAppsModal open={downloadOpen} onOpenChange={setDownloadOpen} />
      <ReferralModal open={referralOpen} onOpenChange={closeReferral} />
      <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextLogOutOfYour4770ea0c')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextYouLlNeedToee9fad67')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={performLogout}
            >
              {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
