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
import {
  HelpSubmenu,
  THEME_OPTIONS,
  ThemeSubmenu,
  useLogoutFlow,
} from '@/features/layout/user-menu-shared';
import { isBillingEnabled } from '@/lib/config';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useReferralDialog } from '@/stores/referral-dialog';
import {
  GearSixIcon as CogOne,
  CreditCardIcon as CreditCard,
  DownloadSimple,
  SignOutIcon as LogOut,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
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
  const sidebar = React.useContext(SidebarContext);
  const { selectedAccountId } = useCurrentAccountStore();
  const { isOpen: referralOpen, closeDialog: closeReferral } = useReferralDialog();

  const [menuOpen, setMenuOpen] = useState(false);

  const accountsQuery = useAccountsList();
  // Extracted verbatim to `hooks/account/use-ensure-selected-account.ts` so the
  // standalone `/settings` route — which mounts `SettingsPanel` with no sidebar
  // and therefore no `UserMenu` — can run the same seeding instead of copying
  // it. It reads through the same `useAccountsList()` hook as the query above,
  // so the two callers share one user-scoped cache entry and one fetch.
  useEnsureSelectedAccount();

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

  // For the rows that OPEN something in place — the log-out confirmation, the
  // Help submenu's external tabs. Navigating rows do not use it: they are
  // anchors now, and an anchor needs no deferral because the App Router owns
  // the transition.
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

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
            {/* An anchor, not a handler. `router.push` from a menu row runs the
                RSC fetch cold at click time, and that fetch degrades into a full
                document load whenever it answers wrong — `/accounts` is not in
                `middleware.ts` PUBLIC_ROUTES, so an expired session answers it
                with an HTML redirect to `/auth`. `onClick` keeps the explicit
                close and must not call `preventDefault`: that cancels the
                anchor. */}
            <DropdownMenuItem asChild onClick={() => setMenuOpen(false)} size="sm">
              <Link href={`/accounts/${currentAccount.account_id}`} prefetch>
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
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
          </>
        )}

        {/* Personal settings sits high: it is the item people come here for. The
            account row above goes to the account page — a different
            destination, which is why this one is not also called "settings". */}
        {/* `profile`, NOT `general`. In the merged settings vocabulary
            (`settings-tabs.ts`) `general` is Workspace → General, a
            PROJECT-scoped tab; the user's own name/email/avatar/delete-account
            surface — what the pre-merge `SidePanelUserSettings` called
            `general` — is the `profile` tab. `general` is also absent from
            `ACCOUNT_SCOPED_SETTINGS_TABS`, so with no project open the rail
            filters it out and the panel falls back anyway. Same tab
            `/settings` opens on (`STANDALONE_DEFAULT_SETTINGS_TAB`). */}
        {/* NAVIGATE, do not poke the store.
            `useSettingsPanelStore.openSettings(tab)` only opens something when
            a `SettingsPanel` is mounted to observe it. There are exactly two
            such mounts — `project-layout/project-shell.tsx:195` and
            `workspace/settings/standalone-settings-route.tsx:113` — and
            `UserMenu` is inside NEITHER. Its only mount is the app header
            (`features/layout/app-header.tsx:108`, `variant="header"`), and the
            only layout rendering that header is `app/(app)/accounts/layout.tsx:26`.
            So a store write here set `open: true` with no subscriber and the
            row did nothing at all — the click was silently swallowed.
            `/settings/profile` is the account-scoped door into the same overlay
            (`app/(app)/settings/[tab]/page.tsx` -> `StandaloneSettingsRoute`,
            which mounts the panel itself and validates the segment through
            `parseSettingsTab`).
            `prefetch` explicitly. `app/(app)/settings/loading.tsx` is the
            default `auto` intent would cache nothing for a dynamic route. */}
        <DropdownMenuItem asChild onClick={() => setMenuOpen(false)} size="sm">
          <Link href="/settings/profile" prefetch>
            <CogOne />
            {tHardcodedUi.raw('componentsLayoutUserMenu.line209JsxAttrLabelUserSettings')}
          </Link>
        </DropdownMenuItem>

        {/* `prefetch` explicitly: `(public)/download/page.tsx` awaits `headers()`
            and has no `loading.tsx`. */}
        <DropdownMenuItem asChild onClick={() => setMenuOpen(false)} size="sm">
          <Link href="/download" prefetch>
            <DownloadSimple />
            {tI18nHardcoded.raw('autoFeaturesLayoutUserMenuJsxTextDownloadApps2765d8e7')}
          </Link>
        </DropdownMenuItem>

        {/* `/accounts/<id>?tab=billing`, NOT `/settings/billing`. Billing is
            an ACCOUNT setting and it left the settings overlay for the account
            page; `parseSettingsTab('billing')` returns `null` now, so the old
            href would have landed on the overlay's default tab. Gated on
            `currentAccount` for the same reason — without an account id there
            is no page to open. The `isBillingEnabled() && canManageBilling`
            gate is unchanged: the page renders the Billing section for anyone
            who reaches it, so the row staying hidden is what keeps a member
            without `billing.write` from being handed the link. */}
        {currentAccount && isBillingEnabled() && canManageBilling && (
          <DropdownMenuItem asChild onClick={() => setMenuOpen(false)} size="sm">
            <Link href={`/accounts/${currentAccount.account_id}?tab=billing`} prefetch>
              <CreditCard />
              Billing
            </Link>
          </DropdownMenuItem>
        )}

        <ThemeSubmenu />

        <HelpSubmenu onClose={() => setMenuOpen(false)} />

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

      <ReferralModal open={referralOpen} onOpenChange={closeReferral} />
      {logoutDialog}
    </>
  );
}
