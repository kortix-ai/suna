'use client';

import {
  availableSessionFilterOptions,
  SESSION_FILTER_OPTIONS,
  type SessionFilterValue,
} from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Slack } from '@/features/icon/icons/slack';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { openCommandPalette } from '@/features/workspace/open-command-palette';
import { ProjectChangeRequestsNavItem } from '@/features/workspace/project-sidebar/footer/project-change-requests-nav';
import { ProjectChatGptConnectNavItem } from '@/features/workspace/project-sidebar/footer/project-chatgpt-connect-nav';
import {
  ProjectCommandsNavItem,
  ProjectConnectorsNavItem,
  ProjectCustomizeNavItem,
  ProjectFilesNavItem,
  ProjectSkillsNavItem,
  useCustomizeKeyboardShortcut,
} from '@/features/workspace/project-sidebar/footer/project-customize-nav';
import { ProjectManifestUpgradeAlert } from '@/features/workspace/project-sidebar/footer/project-manifest-upgrade-alert';
import { ProjectSandboxAlert } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import { useAdminRole } from '@/hooks/admin';
import { useIsCreatingProjectSession } from '@/hooks/projects/new-session-guard';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useIsMobile } from '@/hooks/utils';
import { beginSessionTiming, markSessionClick, sessionMark } from '@/lib/session-timing';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useSessionFilterStore } from '@/stores/session-filter-store';
import { listProjectSessions } from '@kortix/sdk';
import {
  CalendarDotsIcon as CalendarClock,
  DotsThreeIcon as HiDotsHorizontal,
  ListIcon as List,
  MagnifyingGlassIcon,
  EnvelopeIcon as Mail,
  ChatsIcon as MessagesSquare,
  SidebarSimpleIcon as PanelLeft,
  UsersIcon as UsersSolid,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { SidebarBalanceWarning } from './footer/project-balance-warning';
import { SidebarUpgradeButton } from './footer/project-upgrade-button';
import { ProjectSwitcher } from './project-switcher';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

const SESSION_FILTER_ICONS: Record<SessionFilterValue, ComponentType<{ className?: string }>> = {
  all: List,
  mine: MessagesSquare,
  shared: UsersSolid,
  slack: Slack,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state, setOpenMobile, holdPeek, toggleSidebar } = useSidebar();
  const isExpanded = state === 'expanded';
  const isMobile = useIsMobile();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  // Filter lives in a persisted store (keyed by project) so it survives the
  // project shell remounting on navigation — local state reset to "all" on
  // every session open / ⌘J / switch.
  const sessionFilter = useSessionFilterStore((s) => s.filterByProject[projectId] ?? 'all');
  const setSessionFilter = useSessionFilterStore((s) => s.setFilter);
  const { data: filterSessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  // Empty = this project has one kind of session, so every filter would render
  // the same list. The dropdown is dropped entirely rather than shown inert.
  const filterOptions = useMemo(
    () => availableSessionFilterOptions(filterSessions ?? []),
    [filterSessions],
  );
  // A persisted filter outlives the sessions that justified it — delete the
  // last Slack session while filtered to Slack and the menu disappears with no
  // way back. Fall back to "all" once the loaded set says the filter is gone.
  const activeFilter: SessionFilterValue =
    filterSessions && !filterOptions.some((option) => option.value === sessionFilter)
      ? 'all'
      : sessionFilter;
  const activeFilterOption =
    SESSION_FILTER_OPTIONS.find((option) => option.value === activeFilter) ??
    SESSION_FILTER_OPTIONS[0];

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

  // Optimistic + shared with every other entry point (see useNewProjectSession).
  // The timing marks + mobile-drawer close fire on the synchronous navigation.
  const newSession = useNewProjectSession(projectId);
  const creatingSession = useIsCreatingProjectSession(projectId);
  const handleNewSession = useCallback(() => {
    markSessionClick();
    newSession({
      onNavigate: (sessionId) => {
        beginSessionTiming(sessionId);
        sessionMark(sessionId, 'session-created');
        if (isMobile) setOpenMobile(false);
      },
    });
  }, [newSession, isMobile, setOpenMobile]);

  // Mobile: the sidebar is a Sheet, so leaving it open would stack the palette
  // dialog on top of it. Dismiss it first — same order as opening a new
  // session from here.
  const handleOpenSearch = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    openCommandPalette();
  }, [isMobile, setOpenMobile]);

  useCustomizeKeyboardShortcut();

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
                  <PanelLeft className="cn-rtl-flip size-4" />
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
                  // The guard already makes a second activation a no-op; the
                  // disabled state is what makes that visible instead of
                  // looking like a dead button worth hammering.
                  disabled={creatingSession}
                  aria-busy={creatingSession}
                  size="md"
                  className="group/menu-button text-sidebar-foreground border-border dark:bg-background dark:hover:bg-background/90 bg-background hover:bg-background/90 relative flex items-center justify-center gap-2 border-[1.2px] text-center !text-sm font-medium [&_svg]:!size-4"
                >
                  <span>
                    {tI18nHardcoded.raw(
                      'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextNew55d0b491',
                    )}
                  </span>
                  <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
                    <Kbd className="text-base">{modSymbol}</Kbd>
                    <Kbd className="text-xs">J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            {/* Sessions are always expanded — no collapse toggle. The header
                label opens the full sessions page and carries the active
                filter; the ⋯ button opens the filter menu, and only appears
                once the project has two or more session sources to choose
                between. */}
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
              <SidebarGroupLabel className="text-muted-foreground/60 mt-1 flex h-6 items-center px-0 text-[11px] font-medium tracking-wider uppercase">
                <div className="flex w-full flex-row items-center gap-0.5">
                  <Link
                    href={`/projects/${projectId}/sessions`}
                    className="hover:text-sidebar-foreground flex min-w-0 flex-1 flex-row items-center gap-1.5 self-stretch px-2 transition-colors duration-150"
                  >
                    <span>Sessions</span>
                    {activeFilter !== 'all' && (
                      <span className="text-muted-foreground/90 truncate tracking-normal normal-case">
                        {tI18nHardcoded.raw(
                          'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextBulled44625b',
                        )}{' '}
                        {activeFilterOption.label}
                      </span>
                    )}
                  </Link>
                  {filterOptions.length > 0 && (
                    <DropdownMenu onOpenChange={holdPeek}>
                      <DropdownMenuContent align="start" className="w-44 p-1">
                        {filterOptions.map((option) => {
                          const OptionIcon = SESSION_FILTER_ICONS[option.value];
                          return (
                            <DropdownMenuItem
                              key={option.value}
                              className="cursor-pointer"
                              onClick={() => setSessionFilter(projectId, option.value)}
                            >
                              <OptionIcon className="h-4 w-4" />
                              {option.label}
                              <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs tabular-nums">
                                {option.count}
                              </span>
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                          type="button"
                          aria-label={tI18nHardcoded.raw(
                            'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxAttrAria39d6d82d',
                          )}
                          className="text-muted-foreground/90 hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center px-2"
                        >
                          <HiDotsHorizontal className="size-3" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                    </DropdownMenu>
                  )}
                </div>
              </SidebarGroupLabel>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <ProjectSessionList projectId={projectId} filter={activeFilter} />
                </div>
              </div>
            </div>
          </SidebarGroup>

          <SidebarGroup className="mt-auto py-0.5">
            <SidebarMenu>
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              {/* Sits directly above Files/Customize so a still-on-v1 manifest
                  is impossible to miss — one click starts the migration session
                  end-to-end. Self-hides once the project is on v2. */}
              <ProjectManifestUpgradeAlert projectId={projectId} />
              {/* Billing sits ABOVE the permanent nav on purpose. This group is
                  bottom-anchored (mt-auto), so it grows upward as items appear:
                  anything below a late-arriving item gets shoved up the moment
                  billing state lands. Keeping the async items on top means
                  Files/Customize/Connect never move — only the session list
                  above them gives up the space. */}
              <SidebarBalanceWarning accountId={accountId} />
              <SidebarUpgradeButton accountId={accountId} />
              {/* Files used to live on the collapsed icon rail; with the rail
                  gone (offcanvas + hover flyout) it needs a docked entry. Above
                  Customize — files aren't gated behind customize access. */}
              <ProjectFilesNavItem />
              {/* Connectors, Skills, and Commands graduated out of the
                  Customize overlay into their own routed pages — mounted
                  above Customize, same tier as Files. */}
              <ProjectConnectorsNavItem />
              <ProjectSkillsNavItem />
              <ProjectCommandsNavItem />
              <ProjectCustomizeNavItem />
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
