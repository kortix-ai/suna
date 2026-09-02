'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { openCommandPalette } from '@/features/workspace/open-command-palette';
import { ProjectAppsNavItem } from '@/features/workspace/project-sidebar/footer/project-apps-nav';
import { ProjectChangeRequestsNavItem } from '@/features/workspace/project-sidebar/footer/project-change-requests-nav';
import { ProjectChatGptConnectNavItem } from '@/features/workspace/project-sidebar/footer/project-chatgpt-connect-nav';
import { ProjectFilesNavItem } from '@/features/workspace/project-sidebar/footer/project-files-nav';
import { ProjectManifestUpgradeAlert } from '@/features/workspace/project-sidebar/footer/project-manifest-upgrade-alert';
import { ProjectSandboxAlert } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import { ProjectCustomizeNavItem } from '@/features/workspace/project-sidebar/project-settings-nav';
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
import Link from 'next/link';
import { useCallback, useEffect, useRef } from 'react';
import { SidebarBalanceWarning } from './footer/project-balance-warning';
import { SidebarUpgradeButton } from './footer/project-upgrade-button';
import { WorkspaceSwitcher } from './workspace-switcher';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state, setOpenMobile, toggleSidebar } = useSidebar();
  const isExpanded = state === 'expanded';
  const isMobile = useIsMobile();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  const accountId = useBillingAccountId();

  // Open the project composer without creating a durable session.
  const newSession = useNewProjectSession(projectId);
  const creatingSession = useIsCreatingProjectSession(projectId);
  // Cmd+J only. The row itself is an anchor (below), so the keyboard path is
  // the one entry point left that has to ask the hook to navigate.
  const handleNewSession = useCallback(() => {
    newSession();
    if (isMobile) setOpenMobile(false);
  }, [newSession, isMobile, setOpenMobile]);
  // The anchor performs the navigation; this keeps the row's one side effect.
  const handleNewSessionClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  // Shared by the row's anchor and its creating-session state, which stays a
  // real <button> so `disabled` still holds.
  const newSessionRowBody = (
    <>
      <span className="shrink-0">
        <NavigationArrowIcon className="rotate-90" />
      </span>
      <span>
        {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextNew55d0b491')}
      </span>
      <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover/menu-button:opacity-100">
        <Kbd>{modSymbol}</Kbd>
        <Kbd>J</Kbd>
      </KbdGroup>
    </>
  );

  // Mobile: the sidebar is a Sheet, so leaving it open would stack the palette
  // dialog on top of it. Dismiss it first — same order as opening a new
  // session from here.
  const handleOpenSearch = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    openCommandPalette();
  }, [isMobile, setOpenMobile]);

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
      // No background here. This className lands on the sidebar CONTAINER —
      // the square positioning box — while the visible card is the rounded
      // inner box, which already carries `bg-sidebar`. Painting it twice put a
      // square fill behind the flyout card and it showed at all four corners.
      className="[scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
        {/* Offcanvas everywhere: the whole panel slides, so the header keeps a
            single layout. Three controls on one 240px row, all 32px tall: the
            merged brand/switcher control, search, and the panel's own collapse
            toggle — so the collapse control sits inside the thing it collapses
            and the session header no longer has to carry a toggle while the
            panel is docked open.

            ONE control answers "who am I / where am I / where can I go". It was
            three: a `<Link>` carrying the Kortix mark fused to a separate
            dropdown trigger carrying the workspace name up here, plus the user
            menu as a third control down in the footer — two of the three being
            dropdowns. The link is gone, because a control that is half
            navigation and half disclosure makes you guess which half you are
            pointing at. The workspace directory is now a second VIEW of this
            menu, behind "Switch Workspace", which is why there is no footer
            control below any more. */}
        <div className="flex w-full items-center gap-1">
          <div className="min-w-0">
            <WorkspaceSwitcher projectId={projectId} />
          </div>
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
                className="shrink-0"
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
                  className="shrink-0"
                >
                  <PanelLeft className="cn-rtl-flip" />
                </Button>
              </Hint>
            )}
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-full min-h-0 flex-col space-y-2">
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                {creatingSession ? (
                  <SidebarMenuButton
                    disabled
                    aria-busy
                    className="group/menu-button text-sidebar-foreground relative"
                  >
                    {newSessionRowBody}
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    asChild
                    className="group/menu-button text-sidebar-foreground relative"
                  >
                    <Link href={`/projects/${projectId}`} prefetch onClick={handleNewSessionClick}>
                      {newSessionRowBody}
                    </Link>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>

              <ProjectCustomizeNavItem />
              <ProjectAppsNavItem />
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            <ProjectSessionList projectId={projectId} />
          </SidebarGroup>

          <SidebarGroup className="mt-auto">
            <SidebarMenu className="gap-1">
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              <ProjectManifestUpgradeAlert projectId={projectId} />
              <SidebarBalanceWarning accountId={accountId} />
              <ProjectFilesNavItem />
              <ProjectChatGptConnectNavItem projectId={projectId} />
              <SidebarUpgradeButton accountId={accountId} />
            </SidebarMenu>
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
