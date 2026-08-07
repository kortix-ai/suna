'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { openCommandPalette } from '@/features/workspace/open-command-palette';
import { ProjectChangeRequestsNavItem } from '@/features/workspace/project-sidebar/footer/project-change-requests-nav';
import { ProjectChatGptConnectNavItem } from '@/features/workspace/project-sidebar/footer/project-chatgpt-connect-nav';
import { ProjectFilesNavItem } from '@/features/workspace/project-sidebar/footer/project-files-nav';
import { ProjectAppsNavItem } from '@/features/workspace/project-sidebar/footer/project-apps-nav';
import { ProjectManifestUpgradeAlert } from '@/features/workspace/project-sidebar/footer/project-manifest-upgrade-alert';
import { ProjectSandboxAlert } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import {
  ProjectCustomizeNavItem,
  ProjectSettingsNavItem,
  useSettingsKeyboardShortcut,
} from '@/features/workspace/project-sidebar/project-settings-nav';
import { useAdminRole } from '@/hooks/admin';
import { useIsCreatingProjectSession } from '@/hooks/projects/new-session-guard';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useIsMobile } from '@/hooks/utils';
import { useBillingAccountId } from '@/stores/billing-account-context';
import {
  MagnifyingGlassIcon,
  NavigationArrowIcon,
  SidebarSimpleIcon as PanelLeft,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SidebarBalanceWarning } from './footer/project-balance-warning';
import { SidebarUpgradeButton } from './footer/project-upgrade-button';
import { ProjectSwitcher } from './project-switcher';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state, setOpenMobile, toggleSidebar } = useSidebar();
  const isExpanded = state === 'expanded';
  const isMobile = useIsMobile();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  const accountId = useBillingAccountId();

  const { user: authUser } = useAuth();
  const user = useMemo(
    () => ({
      name: authUser?.user_metadata?.name || authUser?.email?.split('@')[0] || 'User',
      email: authUser?.email ?? '',
      avatar: authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture || '',
      isAdmin,
    }),
    [authUser, isAdmin],
  );

  // Open the project composer without creating a durable session.
  const newSession = useNewProjectSession(projectId);
  const creatingSession = useIsCreatingProjectSession(projectId);
  const handleNewSession = useCallback(() => {
    newSession();
    if (isMobile) setOpenMobile(false);
  }, [newSession, isMobile, setOpenMobile]);

  // Mobile: the sidebar is a Sheet, so leaving it open would stack the palette
  // dialog on top of it. Dismiss it first — same order as opening a new
  // session from here.
  const handleOpenSearch = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    openCommandPalette();
  }, [isMobile, setOpenMobile]);

  useSettingsKeyboardShortcut();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'j' || event.key === 'J')
      ) {
        event.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewSession]);

  return (
    <Sidebar
      collapsible="offcanvas"
      variant="inset"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
        {/* Offcanvas everywhere: the whole panel slides, so the header keeps a
            single layout. Three controls on one 240px row, all 32px tall: the
            merged brand/switcher control, search, and the panel's own collapse
            toggle — so the collapse control sits inside the thing it collapses
            and the session header no longer has to carry a toggle while the
            panel is docked open.

            The Kortix mark used to be a separate button sitting beside the
            switcher. Same subject, two mismatched controls, and dead space
            between them. It is one segmented control now (see
            ProjectSwitcher): the mark still links to the project's home, the
            name still opens the switcher, and the whole row between them is
            live instead of inert. */}
        <div className="flex w-full items-center gap-1">
          <ProjectSwitcher variant="sidebar" className="min-w-0 flex-1" />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {/* Search is the palette's only pointer-reachable entry point —
                ⌘K is otherwise the whole discovery story. Renders on mobile
                too: there is no keystroke to fall back on there. */}
            <Hint
              side="bottom"
              label={
                <span className="flex items-center gap-1.5">
                  Search
                  <KbdGroup>
                    <Kbd className="font-mono">{modSymbol}</Kbd>
                    <Kbd className="font-mono">K</Kbd>
                  </KbdGroup>
                </span>
              }
            >
              <Button
                type="button"
                aria-label="Search"
                variant="ghost"
                size="icon"
                onClick={handleOpenSearch}
                className="text-muted-foreground hover:text-foreground size-8 shrink-0 cursor-pointer rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
              >
                <MagnifyingGlassIcon className="size-4" />
              </Button>
            </Hint>
            {/* Desktop only. On mobile the panel is a Sheet — it has no docked
                state to collapse (`state` there still reads the desktop cookie),
                and it already dismisses by backdrop/swipe. Clicking while the
                panel is a hover flyout docks it open, hence the "Pin" label. */}
            {!isMobile && (
              <Hint
                side="bottom"

                label={
                  <span className="flex items-center gap-1.5">
                    {isExpanded ? 'Collapse sidebar' : 'Pin sidebar'}
                    <KbdGroup>
                      <Kbd className="font-mono">{modSymbol}</Kbd>
                      <Kbd className="font-mono">B</Kbd>
                    </KbdGroup>
                  </span>
                }
              >
                <Button
                  type="button"
                  aria-label={isExpanded ? 'Collapse sidebar' : 'Pin sidebar'}
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  className="text-muted-foreground hover:text-foreground size-8 shrink-0 cursor-pointer rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
                >
                  <PanelLeft className="cn-rtl-flip" />
                </Button>
              </Hint>
            )}
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-full min-h-0 flex-col space-y-4">
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  disabled={creatingSession}
                  aria-busy={creatingSession}
                  className="group/menu-button text-muted-foreground hover:text-sidebar-foreground relative flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
                >
                  <span className="shrink-0">
                    <NavigationArrowIcon className="rotate-90" />
                  </span>
                  <span>
                    {tI18nHardcoded.raw(
                      'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextNew55d0b491',
                    )}
                  </span>
                  <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
                    <Kbd>{modSymbol}</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <ProjectCustomizeNavItem />
            </SidebarMenu>
          </SidebarGroup>

          {/* Sessions are always expanded — no collapse toggle. The `Sessions`
              header (label + ⋯ filter menu) now lives inside ProjectSessionList
              so it shares that component's data and horizontal padding. */}
          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            <ProjectSessionList projectId={projectId} />
          </SidebarGroup>

          <SidebarGroup className="mt-auto py-0.5">
            <SidebarMenu>
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              {/* Sits directly above Files so a still-on-v1 manifest is
                  impossible to miss — one click starts the migration session
                  end-to-end. Self-hides once the project is on v2. */}
              <ProjectManifestUpgradeAlert projectId={projectId} />
              {/* Billing sits ABOVE the permanent nav on purpose. This group is
                  bottom-anchored (mt-auto), so it grows upward as items appear:
                  anything below a late-arriving item gets shoved up the moment
                  billing state lands. Keeping the async items on top means
                  Files/Connect never move — only the session list above them
                  gives up the space. */}
              <SidebarBalanceWarning accountId={accountId} />
              <SidebarUpgradeButton accountId={accountId} />
              {/* Files used to live on the collapsed icon rail; with the rail
                  gone (offcanvas + hover flyout) it needs a docked entry.
                  Connectors, Skills, Commands, and Customize used to follow it
                  here — one Settings entry, on the Customize row's old line,
                  replaced all four. */}
              <ProjectFilesNavItem />
              <ProjectAppsNavItem />
              <ProjectSettingsNavItem />
              <ProjectChatGptConnectNavItem projectId={projectId} />
            </SidebarMenu>
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter className="space-y-0.5 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
        <UserMenu user={user} variant="sidebar" />
      </SidebarFooter>

      {/* No resize rail while collapsed — the edge is the hover-peek zone. */}
      {isExpanded && <SidebarRail />}
    </Sidebar>
  );
}
