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
 * User settings opens the same settings panel as the header `UserMenu`, through
 * the same `useSettingsPanelStore.openSettings(tab)` call. `main` authored this
 * against the deleted `SidePanelUserSettings` modal; this branch replaced that
 * modal with the panel (JAY-498), so the row was repointed rather than dropped.
 * Account settings (`/accounts/:id`) is reached from that panel — not from this
 * menu — so the switcher stays about the workspace.
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
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useState } from 'react';

export function WorkspaceSwitcher({ projectId }: { projectId: string }) {
  const router = useRouter();
  const sidebar = React.useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);

  // Seeds `selectedAccountId` for a brand-new sign-in. Pre-merge this ran here
  // by way of `ProjectSidebar` rendering `UserMenu` in its footer — see the
  // hook's own header comment, which names that mount as its reachability
  // guarantee. `main` replaced that footer menu with THIS control, so the call
  // moved with it rather than being silently dropped: without it, every
  // account-scoped settings tab opened on a project whose detail query has not
  // resolved yet has no account id to probe with, and renders as though the
  // permission were denied. Same `['accounts']` key and `staleTime` as every
  // other caller, so React Query serves them all from one fetch.
  useEnsureSelectedAccount();

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
                  'group/workspace relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2',
                  'transition-colors duration-150',
                  'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
                )}
              >
                {/* Nothing, not a skeleton. The tile's initial and the label
                    both come from the name, so a placeholder would paint a
                    shape that swaps content the moment the query lands. The
                    control keeps its size either way — the row is a fixed
                    `h-8` — so the empty state is a quiet gap, not a jump. */}
                {project ? (
                  <EntityAvatar label={project.name} emoji={project.icon} size="sm" />
                ) : null}

                <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
                  {project?.name ?? null}
                </span>

                <CaretUpDownIcon className="text-muted-foreground/50 group-hover/workspace:text-muted-foreground size-3.5 shrink-0 transition-colors duration-150 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="border-foreground/10 w-[256px] space-y-0.5 overflow-hidden shadow-lg"
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

                    <DropdownMenuItem
                      onSelect={() => deferAfterClose(() => router.push('/new'))}
                      size="sm"
                    >
                      <PlusIcon />
                      Create a workspace…
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => openUserSettings('general')} size="sm">
                <CogOne />
                User Settings
              </DropdownMenuItem>

              <DropdownMenuItem
                onSelect={() => deferAfterClose(() => router.push('/download'))}
                size="sm"
              >
                <DownloadSimple />
                Download App
              </DropdownMenuItem>

              <ThemeSubmenu />

              <HelpSubmenu deferAfterClose={deferAfterClose} onClose={() => setMenuOpen(false)} />

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
