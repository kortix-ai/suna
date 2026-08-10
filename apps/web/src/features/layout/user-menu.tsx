'use client';

import { ReferralModal } from '@/components/referrals/referral-modal';
import { Button } from '@/components/ui/button';
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
import {
  HelpSubmenu,
  THEME_OPTIONS,
  ThemeSubmenu,
  useLogoutFlow,
} from '@/features/layout/user-menu-shared';
import { isBillingEnabled } from '@/lib/config';
import { type SettingsTabId } from '@/lib/menu-registry';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useReferralDialog } from '@/stores/referral-dialog';
import { listAccounts } from '@kortix/sdk';
import {
  GearSixIcon as CogOne,
  CreditCardIcon as CreditCard,
  DownloadSimple,
  SignOutIcon as LogOut,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';

export type UserMenuVariant = 'header' | 'sidebar';

// Re-exported: `THEME_OPTIONS` moved to `user-menu-shared.tsx` when the sidebar
// grew its own menu, and this stayed its public entry point.
export { THEME_OPTIONS };

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
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const { isOpen: referralOpen, closeDialog: closeReferral } = useReferralDialog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');

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

  // In the collapsed sidebar's hover flyout, the menu content portals outside
  // the panel — hovering it fires the panel's pointer-leave and would collapse
  // the flyout out from under the open menu. Pin the flyout open while it's up.
  useEffect(() => {
    if (variant !== 'sidebar' || !menuOpen) return;
    sidebar?.holdPeek(true);
    return () => sidebar?.holdPeek(false);
  }, [menuOpen, variant, sidebar]);

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

  const { openConfirm: openLogoutConfirm, dialog: logoutDialog } = useLogoutFlow(deferAfterClose);

  /**
   * One Help row.
   *
   * External rows render a real `<a target="_blank">` rather than calling
   * `window.open` from a handler. Three reasons: the browser opens the tab
   * inside the click's own user-gesture window, so no popup blocker can eat it
   * — `deferAfterClose` defers a frame, which is exactly the kind of gap that
   * trips one; cmd-click and middle-click keep working; and it is a link, so it
   * reads as one to a screen reader.
   *
   * In the desktop shell `openExternalRoute` fires first and returns true — it
   * hands the URL to the system browser — so the anchor's own navigation is
   * cancelled to avoid opening the page twice.
   *
   * This is a plain function, not a component, so the rows are not remounted on
   * every render of the menu.
   */
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
        size="sm"
        className={cn(
          'group/user relative gap-2 p-1',
          // 'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'relative flex cursor-pointer items-center gap-2 rounded-md transition-colors duration-150',
          'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
        )}
      >
        <UserAvatar
          email={user.email}
          name={user.name}
          avatarUrl={user.avatar}
          size="sm"
          className="border-border border"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start justify-start space-y-0 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="text-foreground truncate text-sm font-medium tracking-tight">
            {user.name}
          </span>
        </div>
      </SidebarMenuButton>
    );

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'sidebar' ? 'start' : 'end'}
        // `bottom` for both variants now. The sidebar copy opened upward while
        // it lived in the FOOTER; it is the control at the TOP of the sidebar
        // since the merge, where `top` would fly the menu off the viewport.
        side="bottom"
        sideOffset={variant === 'sidebar' ? 6 : 8}
        className="w-[256px] space-y-0.5 overflow-hidden"
      >
        {currentAccount && (
          <>
            <DropdownMenuItem
              onClick={() =>
                deferAfterClose(() => router.push(`/accounts/${currentAccount.account_id}`))
              }
              size="sm"
            >
              {/* No avatar: the trigger right below already shows it, and
                  repeating it inside the menu it opened is decoration. The
                  email is the identifier that actually disambiguates which
                  account you are about to open. */}
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-foreground truncate text-sm font-medium">{user.email}</div>
                <div className="text-muted-foreground/70 mt-0.5 truncate text-xs">
                  {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextAccountSettings007162f5')}
                </div>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Personal settings sits high: it is the item people come here for. The
            account row above goes to the account page — a different
            destination, which is why this one is not also called "settings". */}
        <DropdownMenuItem onClick={() => openUserSettings('general')} size="sm">
          <CogOne />
          {tHardcodedUi.raw('componentsLayoutUserMenu.line209JsxAttrLabelUserSettings')}
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => deferAfterClose(() => router.push('/download'))} size="sm">
          <DownloadSimple />
          {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextDownloadApps2765d8e7')}
        </DropdownMenuItem>

        {isBillingEnabled() && canManageBilling && (
          <DropdownMenuItem
            onClick={() =>
              deferAfterClose(() =>
                useAccountSettingsModalStore.getState().openAccountSettings({ tab: 'billing' }),
              )
            }
            size="sm"
          >
            <CreditCard />
            Billing
          </DropdownMenuItem>
        )}

        <ThemeSubmenu />

        <HelpSubmenu deferAfterClose={deferAfterClose} onClose={() => setMenuOpen(false)} />

        {/* Log out is the only row that ends something, so it gets its own
            group. Nothing sits below it — the last item in a menu is the one a
            slipped pointer lands on. */}
        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={openLogoutConfirm} size="sm">
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
      <ReferralModal open={referralOpen} onOpenChange={closeReferral} />
      {logoutDialog}
    </>
  );
}
