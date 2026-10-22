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
 * like the things you can move to. You are one menu open away, though: the menu
 * opens on the signed-in identity (KRTX-1810) — the shell's only
 * "who am I" surface since the old footer user menu was folded into this
 * control — and keeps the account rows below it.
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
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@kortix/ui/sidebar';
import { Skeleton } from '@kortix/ui/skeleton';
import { accountCreated } from '@/features/accounts/account-created';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { DownloadModal } from '@/features/marketing/download/download-modal';
import { Download } from '@kortix/ui/internal/icons/download';
import { useAuth } from '@/features/providers/auth-provider';
import { HelpSubmenu, ThemeSubmenu, useLogoutFlow } from '@/features/layout/user-menu-shared';
import { COMPUTER_SETUP_EVENT } from '@kortix/ui/internal/tunnel/computer-connect';
import { LocalComputerModal } from '@/features/tunnel/local-computer-modal';
import { newWorkspacePathForAccount } from '@kortix/ui/workspace/new/account-param';
import { useCreatableAccounts } from '@kortix/ui/workspace/new/use-creatable-accounts';
import { PROJECT_ACTIONS } from '@kortix/sdk';
import { useProjectCan } from '@kortix/ui/internal/lib/use-project-can';
import { projectSettingsSectionHref } from '@kortix/ui/customize/project-settings/project-settings-sections';
import { WorkspaceMenuSection } from '@kortix/ui/workspace/sidebar/workspace-menu-section';
import { settingsShortcutLabel } from '@/features/workspace/settings/settings-shortcut';
import { type SettingsTab } from '@kortix/ui/customize/settings/settings-tabs';
import { useAccountsList, useAccountsQueryKey } from '@kortix/ui/internal/hooks/account/use-accounts-list';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useAdminRole } from '@kortix/ui/internal/hooks/admin/use-admin-role';
import { isAccountCreationRestricted } from '@/lib/config';
import { cn } from '@kortix/ui';
import { useCurrentAccountStore } from '@kortix/ui/internal/stores/current-account-store';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { getProject, type KortixAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ArrowsLeftRightIcon,
  CaretUpDownIcon,
  GearSixIcon as CogOne,
  SignOutIcon as LogOut,
  PencilSimpleIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';

export function WorkspaceSwitcher({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('sidebar');
  const tUi = useI18nTranslations('hardcodedUi.i18nComplete');
  const canRename = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE).allowed;
  const tNewWorkspace = useI18nTranslations('newWorkspace');
  const sidebar = React.useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useAuth();
  // The identity line the account top bar shows on /projects and /new — same
  // precedence, same fallback — so the shell's menu says who is signed in the
  // same way those pages do (KRTX-1810).
  const identity = user?.user_metadata?.name?.trim() || user?.email || null;

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
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [computerSetupOpen, setComputerSetupOpen] = useState(false);
  // Right after this desktop pairs, setup opens on the spot (see COMPUTER_SETUP_EVENT).
  // The sidebar's computer row and the Connectors pages open the other dialogs.
  useEffect(() => {
    const openSetup = () => setComputerSetupOpen(true);
    window.addEventListener(COMPUTER_SETUP_EVENT, openSetup);
    return () => window.removeEventListener(COMPUTER_SETUP_EVENT, openSetup);
  }, []);
  const { data: adminRole } = useAdminRole();
  // Self-host hides the row for non-admins when account creation is restricted
  // — admins are exempt (see `isAccountCreationRestricted()` /
  // KORTIX_RESTRICT_ACCOUNT_CREATION). The backend 403
  // (`account_creation_restricted`) is the authoritative gate; this only avoids
  // offering an affordance the person cannot use.
  const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);
  // "New workspace" opens `/new`, which offers only the accounts where the
  // caller holds `project.create`. With none, the row leads nowhere.
  const canCreateWorkspace = useCreatableAccounts(useAccountsList().data ?? []).length > 0;

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
                  'group/workspace hover:bg-sidebar-row relative flex cursor-pointer items-center gap-2 rounded-md px-1',
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
              {/* The identity header: the same "Logged in as" treatment as the
                  account top bar (`account-top-bar.tsx`), two lines — the copy
                  above the name or email. A label, not a row: it is not focusable
                  and does nothing, it just tells you which session the rows below
                  (Settings, Log out) would act on. */}
              <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5 font-normal">
                <span className="text-muted-foreground text-xs">
                  {tNewWorkspace('account.loggedInAs')}
                </span>
                <span className="text-foreground max-w-56 truncate text-sm">
                  {identity ?? tNewWorkspace('account.label')}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowsLeftRightIcon weight="fill" />
                  {t('workspace.switchMenu')}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-[264px] space-y-0.5" sideOffset={6}>
                    <WorkspaceMenuSection />

                    {(canCreateWorkspace || canCreateAccount) && <DropdownMenuSeparator />}

                    {/* An anchor, not a handler. `router.push` from a menu row
                        runs the RSC fetch cold at click time, and that fetch
                        degrades into a full document load whenever it answers
                        wrong — an auth bounce, a build-id skew mid-deploy, a
                        network blip. `onSelect` keeps the explicit close and
                        must not call `preventDefault`: that cancels the
                        anchor. */}
                    {canCreateWorkspace && (
                      <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                        <Link href="/new" prefetch>
                          <PlusIcon />
                          {t('workspace.create')}
                        </Link>
                      </DropdownMenuItem>
                    )}

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

              {canRename === true && (
                <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                  <Link href={projectSettingsSectionHref(projectId, 'general')} prefetch>
                    <PencilSimpleIcon />
                    {tUi('text3064d79a295c')}
                  </Link>
                </DropdownMenuItem>
              )}

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

              {/* A modal, not a route: the user stays in the workspace. It
                  renders the same `DownloadOptions` as the public /download
                  page, so the two surfaces never drift apart. */}
              <DropdownMenuItem
                onSelect={() => deferAfterClose(() => setDownloadOpen(true))}
                size="sm"
                data-desktop-hidden
              >
                <Download />
                {t('workspace.downloadApp')}
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

      <DownloadModal open={downloadOpen} onOpenChange={setDownloadOpen} />

      <LocalComputerModal
        projectId={projectId}
        open={computerSetupOpen}
        onOpenChange={setComputerSetupOpen}
      />

      <CreateAccountModal
        open={createAccountOpen}
        onOpenChange={setCreateAccountOpen}
        onCreated={(account: KortixAccount) => {
          accountCreated(account, queryClient, accountsQueryKey, setSelectedAccountId, (path) => {
            router.push(path);
          });
        }}
      />
    </>
  );
}
