'use client';

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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { HelpSubmenu, ThemeSubmenu, useLogoutFlow } from '@/features/layout/user-menu-shared';
import { WorkspaceMenuSection } from '@/features/workspace/project-sidebar/workspace-menu-section';
import { type SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { cn } from '@/lib/utils';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { getProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ArrowsLeftRightIcon,
  CaretUpDownIcon,
  GearSixIcon as CogOne,
  DownloadSimple,
  SignOutIcon as LogOut,
  PlusIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { useState } from 'react';

export function WorkspaceSwitcher({ projectId }: { projectId: string }) {
  const sidebar = React.useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);

  // Seeds `selectedAccountId` for a brand-new sign-in. Pre-merge this ran here
  // by way of a `UserMenu` in the project sidebar's FOOTER. That footer menu no
  // longer exists: `ProjectSidebar` renders THIS control and nothing else menu-
  // like (`project-sidebar.tsx:116`), and `UserMenu`'s only remaining mount is
  // the app header (`features/layout/app-header.tsx:108`, reached only from the
  // `app/(app)/accounts` tree). So the call moved here with the control rather
  // than being silently dropped: without it, every account-scoped settings tab
  // opened on a project whose detail query has not resolved yet has no account
  // id to probe with, and renders as though the permission were denied. Same
  // `useAccountsList()` hook as every other caller, so React Query serves them
  // all from one user-scoped fetch.
  useEnsureSelectedAccount();

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
                aria-label="Switch workspace"
                className={cn(
                  'group/workspace hover:bg-card relative flex cursor-pointer items-center gap-2 rounded-md px-1',
                  'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
                )}
              >
                {/* Nothing, not a skeleton. The tile's initial and the label
                    both come from the name, so a placeholder would paint a
                    shape that swaps content the moment the query lands. The
                    control keeps its size either way — the row is a fixed
                    `h-8` — so the empty state is a quiet gap, not a jump. */}
                {/* `glyph` BEFORE `emoji` below, matching EntityAvatar's own
                    precedence. Both are required: a project's icon is a union —
                    an emoji XOR a named glyph — so passing only `emoji` renders
                    a glyph project's chalk INITIAL here, while the projects grid
                    (`projects/project-card.tsx`) and ⌘K
                    (`workspace/command-palette.tsx`) both draw its glyph. The
                    sidebar is where a person looks at their workspace all day,
                    so that gap read as "I picked an icon and nothing changed". */}
                {project ? (
                  <EntityAvatar
                    label={project.name}
                    glyph={project.icon_glyph}
                    emoji={project.icon}
                    size="sm"
                  />
                ) : null}

                <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
                  {project?.name ?? null}
                </span>

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
                  Switch Workspace
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
                        Create a workspace…
                      </Link>
                    </DropdownMenuItem>
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
                Settings
              </DropdownMenuItem>

              {/* `prefetch` explicitly: `(public)/download/page.tsx` awaits
                  `headers()` and has no `loading.tsx`, so the default `auto`
                  intent would cache nothing for a dynamic route. */}
              <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                <Link href="/download" prefetch>
                  <DownloadSimple />
                  Download App
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
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Sibling of the dropdown, never a child — see `useLogoutFlow`. */}
      {logoutDialog}
    </>
  );
}
