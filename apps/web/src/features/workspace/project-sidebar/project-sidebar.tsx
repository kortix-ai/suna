'use client';

import {
  matchesSessionFilter,
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
import { Icon } from '@/features/icon/icon';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { ProjectAppsNavItem } from '@/features/workspace/project-sidebar/footer/project-apps-nav';
import { ProjectChangeRequestsNavItem } from '@/features/workspace/project-sidebar/footer/project-change-requests-nav';
import { ProjectInboxNavItem } from '@/features/workspace/project-sidebar/footer/project-inbox-nav';
import { ProjectChatGptConnectNavItem } from '@/features/workspace/project-sidebar/footer/project-chatgpt-connect-nav';
import {
  ProjectCustomizeNavItem,
  ProjectFilesNavItem,
  useCustomizeKeyboardShortcut,
} from '@/features/workspace/project-sidebar/footer/project-customize-nav';
import { ProjectSandboxAlert } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import { ProjectSwitcher } from '@/features/workspace/project-sidebar/project-switcher';
import { useAdminRole } from '@/hooks/admin';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useIsMobile } from '@/hooks/utils';
import { beginSessionTiming, markSessionClick, sessionMark } from '@/lib/session-timing';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useSessionFilterStore } from '@/stores/session-filter-store';
import { listProjectSessions } from '@kortix/sdk/projects-client';
import { Icon as IconMynauiType, UsersSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarClock,
  List,
  Mail,
  MessagesSquare,
  PanelLeft,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { HiDotsHorizontal } from 'react-icons/hi';
import { IconType } from 'react-icons/lib';
import { SidebarUpgradeButton } from './footer/project-upgrade-button';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

const SESSION_FILTER_ICONS: Record<SessionFilterValue, LucideIcon | IconMynauiType | IconType> = {
  all: List,
  mine: MessagesSquare,
  shared: UsersSolid,
  slack: Icon.Slack,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state, setOpenMobile, toggleSidebar, peek } = useSidebar();
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
  const sessionFilterCounts = useMemo(() => {
    const counts = new Map<SessionFilterValue, number>();
    for (const option of SESSION_FILTER_OPTIONS) {
      counts.set(
        option.value,
        (filterSessions ?? []).filter((s) => matchesSessionFilter(s, option.value)).length,
      );
    }
    return counts;
  }, [filterSessions]);
  const activeFilterOption =
    SESSION_FILTER_OPTIONS.find((option) => option.value === sessionFilter) ??
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
            single layout. The collapse toggle exists only while docked — in
            the flyout the shell's top-left toggle (right above the panel) is
            the pin control, and the project switcher takes the full width. */}
        <div className="flex w-full items-center justify-between gap-1">
          <Button type="button" variant="ghost" size="icon" asChild>
            <Link href={`/projects/${projectId}`}>
              <Icon.Kortix className="text-foreground size-4.5" />
            </Link>
          </Button>
          <div className="w-full min-w-0">
            <ProjectSwitcher variant="sidebar" />
          </div>
          {!peek && (
            <Hint label="Collapse sidebar" side="right">
              <Button
                type="button"
                aria-label="Collapse sidebar"
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="kx-fade-up text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
              >
                <PanelLeft className="cn-rtl-flip size-4" />
              </Button>
            </Hint>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-full min-h-0 flex-col space-y-4">
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  size="md"
                  className="group/menu-button text-sidebar-foreground border-border dark:bg-background dark:hover:bg-background/90 bg-background hover:bg-background/90 flex items-center justify-center border-[1.2px] text-center !text-sm [&_svg]:!size-5"
                >
                  {tI18nHardcoded.raw(
                    'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextNew55d0b491',
                  )}
                  <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
                    <Kbd>{modSymbol}</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            {/* Sessions are always expanded — no collapse toggle. The header
                label only carries the active filter; the ⋯ button opens the
                filter menu. */}
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
              <SidebarGroupLabel className="text-muted-foreground/60 mt-1 flex h-6 items-center px-0 text-xs font-medium tracking-wider uppercase">
                <div className="flex w-full flex-row items-center gap-0.5">
                  <div className="flex min-w-0 flex-1 flex-row items-center gap-0.5 px-2 text-[13px] font-normal">
                    <span>Sessions</span>
                    {sessionFilter !== 'all' && (
                      <span className="text-muted-foreground/90 truncate tracking-normal normal-case">
                        {tI18nHardcoded.raw(
                          'autoFeaturesCoWorkerProjectSidebarProjectSidebarJsxTextBulled44625b',
                        )}{' '}
                        {activeFilterOption.label}
                      </span>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuContent align="start" className="w-44 p-1">
                      {SESSION_FILTER_OPTIONS.map((option) => {
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
                              {sessionFilterCounts.get(option.value) ?? 0}
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
                </div>
              </SidebarGroupLabel>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <ProjectSessionList projectId={projectId} filter={sessionFilter} />
                </div>
              </div>
            </div>
          </SidebarGroup>

          <SidebarGroup className="mt-auto py-0.5">
            <SidebarMenu>
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectInboxNavItem projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              <ProjectAppsNavItem projectId={projectId} />
              {/* Files used to live on the collapsed icon rail; with the rail
                  gone (offcanvas + hover flyout) it needs a docked entry. Above
                  Customize — files aren't gated behind customize access. */}
              <ProjectFilesNavItem />
              <ProjectCustomizeNavItem />
              <ProjectChatGptConnectNavItem projectId={projectId} />
              <SidebarUpgradeButton accountId={accountId} />
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
