'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
/**
 * The project sidebar's one control: which workspace you are in, and everything
 * you can do from here.
 *
 * It is a WORKSPACE switcher, not a user menu — the distinction is the whole
 * point of the component existing separately from `UserMenu` in the app header.
 * The trigger shows the workspace, not you: its icon (an emoji if one is set,
 * otherwise the initials `EntityAvatar` derives from the name) and its name, the
 * same treatment the rows inside the switcher use, so the thing you are in looks
 * like the things you can move to. No account name, no email, no avatar — you
 * already know who you are; what a sidebar has to tell you is where you are.
 *
 * User settings opens the same settings surface the header `UserMenu` opens,
 * on the same `profile` tab — but by a different mechanism, and the difference
 * is not cosmetic. This control only ever renders under `ProjectShell`, which
 * mounts `SettingsPanel` as a sibling (`project-shell.tsx:195`), so poking
 * `useSettingsPanelStore.openSettings(tab)` has a renderer subscribed and the
 * overlay opens in place. `UserMenu` mounts only in the app header under the
 * `app/(app)/accounts` tree, where no `SettingsPanel` exists, so its rows
 * navigate to `/settings/<tab>` instead. `main` authored this row against the
 * deleted `SidePanelUserSettings` modal; this branch replaced that modal with
 * the panel (JAY-498), so the row was repointed rather than dropped.
 * Account settings (`/accounts/:id`) is reached from the "Switch Workspace"
 * submenu, at the top of it, above the workspace list — see
 * `workspace-menu-section.tsx`. That is the one view in this menu already
 * grouped BY account, so it is the only place where "which account" is not a
 * guess. This top-level menu stays about the user and the workspace.
 *
 * The rows that are genuinely account-level and have nowhere else to live in
 * this panel — Install App, Theme, Help, Log out — are shared with `UserMenu`
 * through `user-menu-shared.tsx` rather than copied.
 *
 * This replaced three controls: a `<Link>` carrying the Kortix mark fused to a
 * separate dropdown trigger carrying the workspace name, plus a user menu in the
 * sidebar footer. Two of the three were dropdowns, and the fused one made you
 * guess which half you were pointing at — the left half navigated, the right
 * half disclosed.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { HelpSubmenu, ThemeSubmenu, useLogoutFlow } from '@/features/layout/user-menu-shared';
import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import { WorkspaceMenuSection } from '@/features/workspace/project-sidebar/workspace-menu-section';
import { settingsShortcutLabel } from '@/features/workspace/settings/settings-shortcut';
import { type SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useAccountsQueryKey } from '@/hooks/account/use-accounts-list';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { isAccountCreationRestricted } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { getProject, type KortixAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ArrowsLeftRightIcon,
  CaretUpDownIcon,
  GearSixIcon as CogOne,
  DownloadSimple,
  SignOutIcon as LogOut,
  PlusIcon,
} from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useState } from 'react';

export function WorkspaceSwitcher({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('sidebar');
  const sidebar = React.useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);

  // Seeds `selectedAccountId` for a brand-new sign-in. Pre-merge this ran here
  // by way of a `UserMenu` in the project sidebar's FOOTER. That footer menu no
  // longer exists: `ProjectSidebar` renders THIS control and nothing else menu-
  // like (`project-sidebar.tsx:116`), and `UserMenu` has no remaining mount.
  // So the call moved here with the control rather than being silently
  // dropped: without it, every account-scoped settings tab
  // opened on a project whose detail query has not resolved yet has no account
  // id to probe with, and renders as though the permission were denied. Same
  // `useAccountsList()` hook as every other caller, so React Query serves them
  // all from one user-scoped fetch.
  useEnsureSelectedAccount();

  const router = useRouter();
  const queryClient = useQueryClient();
  const { setSelectedAccountId } = useCurrentAccountStore();
  // The exact key the account list reads, for the create-account seed below.
  const accountsQueryKey = useAccountsQueryKey();
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const { data: adminRole } = useAdminRole();
  // Self-host hides the row for non-admins when account creation is restricted
  // — admins are exempt (see `isAccountCreationRestricted()` /
  // KORTIX_RESTRICT_ACCOUNT_CREATION). The backend 403
  // (`account_creation_restricted`) is the authoritative gate; this only avoids
  // offering an affordance the person cannot use.
  const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);

  // For the rows that OPEN something in place — the settings panel, the log-out
  // confirmation. Navigating rows do not use it: they are anchors now, and an
  // anchor needs no deferral because the App Router owns the transition.
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openUserSettings = (tab: SettingsTab) =>
    deferAfterClose(() => useSettingsPanelStore.getState().openSettings(tab));

  const { openConfirm: openLogoutConfirm, dialog: logoutDialog } = useLogoutFlow(deferAfterClose);

  // `qk.project.summary(id)` is the canonical `getProject` slot — the same entry
  // the rest of the project shell reads, so naming the workspace here costs no
  // extra request. NOT the projects LIST: that waits on `accounts` first, and
  // this control paints before either resolves.
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = projectQuery.data ?? null;

  // In the collapsed sidebar's hover flyout, the menu content portals outside
  // the panel — hovering it fires the panel's pointer-leave and would collapse
  // the flyout out from under the open menu. Pin the flyout while it is up.
  React.useEffect(() => {
    if (!menuOpen) return;
    sidebar?.holdPeek(true);
    return () => sidebar?.holdPeek(false);
  }, [menuOpen, sidebar]);

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                aria-label={t('workspace.switch')}
                className={cn(
                  'group/workspace hover:bg-card relative flex cursor-pointer items-center gap-2 rounded-md px-1',
                  'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
                )}
              >
                {/* Until the project resolves, a tile-shaped and a
                    name-shaped skeleton hold the row. The empty gap this
                    replaced left the caret alone in the corner on every hard
                    refresh, which read as a broken control rather than a
                    loading one. Both shapes match the loaded row (`size-6`
                    tile, one line of text), so nothing shifts when it lands. */}
                {/* `glyph` BEFORE `emoji` below, matching EntityAvatar's own
                    precedence. Both are required: a project's icon is a union —
                    an emoji XOR a named glyph — so passing only `emoji` renders
                    a glyph project's chalk INITIAL here, while the projects grid
                    (`projects/project-card.tsx`) and ⌘K
                    (`workspace/command-palette.tsx`) both draw its glyph. The
                    sidebar is where a person looks at their workspace all day,
                    so that gap read as "I picked an icon and nothing changed". */}
                {project ? (
                  <>
                    <EntityAvatar
                      label={project.name}
                      glyph={project.icon_glyph}
                      emoji={project.icon}
                      size="sm"
                    />
                    <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
                      {project.name}
                    </span>
                  </>
                ) : (
                  <>
                    <Skeleton className="size-6 shrink-0 rounded-sm py-0" />
                    <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                      <Skeleton className="h-3 w-24 py-0" />
                    </span>
                  </>
                )}

                <CaretUpDownIcon className="text-muted-foreground/50 group-hover/workspace:text-muted-foreground size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="border-foreground/10 w-[15rem] space-y-0.5 overflow-hidden shadow-lg"
            >
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowsLeftRightIcon weight="fill" />
                  {t('workspace.switchMenu')}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-[264px] space-y-0.5" sideOffset={6}>
                    <WorkspaceMenuSection />

                    <DropdownMenuSeparator />

                    {/* An anchor, not a handler. `router.push` from a menu row
                        runs the RSC fetch cold at click time, and that fetch
                        degrades into a full document load whenever it answers
                        wrong — an auth bounce, a build-id skew mid-deploy, a
                        network blip. `onSelect` keeps the explicit close and
                        must not call `preventDefault`: that cancels the
                        anchor. */}
                    <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                      <Link href="/new" prefetch>
                        <PlusIcon />
                        {t('workspace.create')}
                      </Link>
                    </DropdownMenuItem>

                    {/* The account-level sibling of the row above, in the one
                        menu already grouped BY account. A handler rather than
                        an anchor: creating an account opens a modal, and the
                        only other affordance that does so lives in the hub's
                        account-list pane — which no live entry point reaches,
                        because every one of them opens the hub ON an account
                        (`hubTarget(accountId)`) and the list is `hubTarget(null)`.
                        That pane is why this row is a second affordance rather
                        than a move: reachable only by opening Account settings
                        and then clicking the hub's root breadcrumb, it left the
                        product with no discoverable way to create an account. */}
                    {canCreateAccount && (
                      <DropdownMenuItem
                        onSelect={() => deferAfterClose(() => setCreateAccountOpen(true))}
                        size="sm"
                      >
                        <PlusIcon />
                        {t('workspace.createAccount')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />

              {/* `profile`, NOT `general`. In the merged settings vocabulary
                  (`settings/settings-tabs.ts`) `general` is Workspace →
                  General, a PROJECT-scoped tab — a row labelled "User
                  Settings" that opens it lands the user on the workspace pane.
                  The user's own name/email/avatar/delete-account surface is the
                  `profile` tab, and it is the tab `/settings` opens on
                  (`STANDALONE_DEFAULT_SETTINGS_TAB`). This row pokes the store
                  rather than navigating because `ProjectSidebar` only mounts
                  under `ProjectShell`, which renders `SettingsPanel` as a
                  sibling (`project-layout/project-shell.tsx:195`) — the
                  header `UserMenu` has no such renderer and must navigate. */}
              <DropdownMenuItem onSelect={() => openUserSettings('profile')} size="sm">
                <CogOne />
                {t('workspace.settings')}
                {/* The keycap sits on this row because this row is what the
                    keystroke does — `useSettingsKeyboardShortcut` calls the
                    same `openSettings()`. It is the only row in the app that
                    opens the overlay, so it is the only honest place to
                    advertise Mod+, (the old sidebar Settings row that carried
                    it was removed on 2026-08-17, and the shortcut has been
                    undiscoverable since). The symbol follows the platform;
                    the handler accepts Cmd and Ctrl on all of them.

                    `DropdownMenuShortcut` (plain muted text, `MENU_SHORTCUT`)
                    rather than `<Kbd>` chips: this is a menu row, and that is
                    the recipe every menu row in the design system uses for a
                    trailing keystroke. */}
                <DropdownMenuShortcut>{settingsShortcutLabel()}</DropdownMenuShortcut>
              </DropdownMenuItem>

              {/* `prefetch` explicitly: `(public)/download/page.tsx` awaits
                  `headers()` and has no `loading.tsx`, so the default `auto`
                  intent would cache nothing for a dynamic route. */}
              <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                <Link href="/download" prefetch data-desktop-hidden>
                  <DownloadSimple />
                  {t('workspace.downloadApp')}
                </Link>
              </DropdownMenuItem>

              <ThemeSubmenu />

              <HelpSubmenu onClose={() => setMenuOpen(false)} />

              {/* Log out is the only row that ends something, so it gets its own
                  group. Nothing sits below it — the last item in a menu is the
                  one a slipped pointer lands on. */}
              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={openLogoutConfirm} size="sm">
                <LogOut />
                {t('workspace.logOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Sibling of the dropdown, never a child — see `useLogoutFlow`. */}
      {logoutDialog}

      <CreateAccountModal
        open={createAccountOpen}
        onOpenChange={setCreateAccountOpen}
        onCreated={(account: KortixAccount) => {
          // The reader's OWN key, not a hand-built one: writer and reader on
          // different keys is silent — the create appears to succeed and the
          // list never changes. Same seed as the hub's account-list pane.
          queryClient.setQueryData<KortixAccount[]>(accountsQueryKey, (accounts) => {
            const current = accounts ?? [];
            return current.some((item) => item.account_id === account.account_id)
              ? current.map((item) => (item.account_id === account.account_id ? account : item))
              : [account, ...current];
          });
          // `scope()`, not `list(userId)`: the "account list changed" prefix,
          // which reaches the only slot that can be live without the callback
          // having to re-derive whose slot it is.
          void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
          setSelectedAccountId(account.account_id);
          void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
          // `/new` scoped to the account just created — NOT the landing door.
          // The door opens the remembered project in ANY account
          // (`decideDoor`), so a brand-new empty account falls through to
          // some other account's project, and
          // `projects/start/page.tsx` then heals the persisted selection to
          // THAT account — undoing the switch above and making the whole
          // create look like it did nothing. A new account's honest next step
          // is its first workspace.
          router.push(newWorkspacePathForAccount(account.account_id));
        }}
      />
    </>
  );
}
