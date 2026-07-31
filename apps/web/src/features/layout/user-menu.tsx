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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { isBillingEnabled } from '@/lib/config';
import { openExternalRoute } from '@/lib/desktop';
import { type SettingsTabId } from '@/lib/menu-registry';
import { createClient } from '@/lib/supabase/client';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { resetClientState } from '@/lib/utils/reset-client-state';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useReferralDialog } from '@/stores/referral-dialog';
import { listAccounts } from '@kortix/sdk';
import {
  ArticleIcon,
  BookOpenIcon,
  GearSixIcon as CogOne,
  CreditCardIcon as CreditCard,
  DownloadSimple,
  HeadsetIcon,
  HouseIcon,
  LifebuoyIcon,
  SignOutIcon as LogOut,
  PaperPlaneTiltIcon,
  QuestionIcon,
  ScrollIcon,
  ShieldCheckIcon,
  StorefrontIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';

export type UserMenuVariant = 'header' | 'sidebar';

type MenuLink = {
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  /**
   * Navigate in place instead of opening a new tab. Only Marketplace: it is
   * somewhere you go and act — browse, install — so it belongs in the session
   * you are already in. Everything else under Help is something you read, and
   * losing your workspace to go read it is the wrong trade.
   */
  internal?: boolean;
};

/**
 * Reference destinations, grouped under Help.
 *
 * Hoisted to module scope so the arrays and their objects are allocated once
 * for the app instead of being rebuilt on every render — `UserMenu` mounts in
 * both the sidebar and the header, so this render path is not rare.
 *
 * Every entry but Marketplace opens in a new tab. These are pages you read, and
 * the person clicking them is mid-session in a workspace — sending them away
 * from it to read the privacy policy costs more than the tab does.
 */
const HELP_LINKS: MenuLink[] = [
  { label: 'Help center', href: '/help', Icon: LifebuoyIcon },
  { label: 'Docs', href: '/docs', Icon: BookOpenIcon },
  { label: 'Blog', href: '/blog', Icon: ArticleIcon },
  { label: 'Marketplace', href: '/marketplace', Icon: StorefrontIcon, internal: true },
  { label: 'Contact', href: '/contact', Icon: PaperPlaneTiltIcon },
  { label: 'Support', href: '/support', Icon: HeadsetIcon },
];

/** Kept separate so a divider can hold the legal pages apart from the rest. */
const LEGAL_LINKS: MenuLink[] = [
  { label: 'Privacy', href: '/legal?tab=privacy', Icon: ShieldCheckIcon },
  { label: 'Terms and conditions', href: '/legal?tab=terms', Icon: ScrollIcon },
];

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

  const openLogoutConfirm = () => deferAfterClose(() => setLogoutConfirmOpen(true));

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
  const renderMenuLink = ({ label, href, Icon, internal }: MenuLink) =>
    internal ? (
      <DropdownMenuItem key={href} onClick={() => deferAfterClose(() => router.push(href))}>
        <Icon />
        {label}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuItem key={href} asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (openExternalRoute(href)) event.preventDefault();
            setMenuOpen(false);
          }}
        >
          <Icon />
          {label}
        </a>
      </DropdownMenuItem>
    );

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

        <DropdownMenuItem onClick={() => deferAfterClose(() => router.push('/projects'))} size="sm">
          <HouseIcon />
          Home
        </DropdownMenuItem>

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

        {/* Every reference and legal page collapses into one submenu, so the top
            level only carries things you act on rather than eight links. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <QuestionIcon />
            Help
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="space-y-0.5" sideOffset={6}>
              {HELP_LINKS.map(renderMenuLink)}

              <DropdownMenuSeparator />

              {LEGAL_LINKS.map(renderMenuLink)}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>

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

        <DropdownMenuItem variant="destructive" onClick={openLogoutConfirm} size="sm">
          <LogOut />

          {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Not a menu item: it hosts a toggle rather than being selectable. It
            still has to sit in the same column as the items above it, hence the
            shared row geometry. The focus: and data-disabled: rules it used to
            carry were dead — this div is not focusable and Radix never marks it
            disabled, so only the ThemeToggle inside ever takes focus. */}
        <div
          className={cn(
            'text-foreground/80 flex cursor-default items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm font-normal select-none',
            '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
          )}
        >
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
            <AlertDialogAction variant="destructive" onClick={performLogout}>
              {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
