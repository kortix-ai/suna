'use client';

import {
  matchesSessionFilter,
  SESSION_FILTER_OPTIONS,
  type SessionFilterValue,
} from '@/components/projects/session-label';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { errorToast } from '@/components/ui/toast';
import { ProjectAppsNavItem } from '@/features/co-worker/project-sidebar/footer/project-apps-nav';
import { ProjectChangeRequestsNavItem } from '@/features/co-worker/project-sidebar/footer/project-change-requests-nav';
import { ProjectCustomizeNavItem } from '@/features/co-worker/project-sidebar/footer/project-customize-nav';
import { OnboardingSetupNavItem } from '@/features/co-worker/project-sidebar/footer/project-onboarding-setup';
import { ProjectSandboxAlert } from '@/features/co-worker/project-sidebar/footer/project-sandbox-alert';
import { ProjectSessionList } from '@/features/co-worker/project-sidebar/project-session-list';
import { ProjectSwitcher } from '@/features/co-worker/project-sidebar/project-switcher';
import { Icon } from '@/features/icon/icon';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { useAdminRole } from '@/hooks/admin';
import { useIsMobile } from '@/hooks/utils';
import {
  createProjectSession,
  listProjectSessions,
  prefetchSessionStart,
} from '@/lib/projects-client';
import { beginSessionTiming, markSessionClick, sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
import { Icon as IconMynauiType, UsersSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  ChevronRight,
  List,
  MessagesSquare,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HiDotsHorizontal } from 'react-icons/hi';
import { IconType } from 'react-icons/lib';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

const SESSION_FILTER_ICONS: Record<SessionFilterValue, LucideIcon | IconMynauiType | IconType> = {
  all: List,
  mine: MessagesSquare,
  shared: UsersSolid,
  slack: Icon.Slack,
  schedule: CalendarClock,
  webhook: Webhook,
};

// function KbdHint({ mod, letter }: { mod: string; letter: string }) {
//   const chip =
//     'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/40 bg-foreground/[0.05] px-1 text-xs font-medium leading-none text-muted-foreground/70 select-none';
//   return (
//     <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/menu-button:opacity-100 group-data-[collapsible=icon]:hidden">
//       <kbd className={chip}>{mod}</kbd>
//       <kbd className={chip}>{letter}</kbd>
//     </span>
//   );
// }

interface CollapsedIconButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  flyoutContent?: React.ReactNode;
  disabled?: boolean;
  isActive?: boolean;
}

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isExpanded = state === 'expanded';
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  const [sessionFilter, setSessionFilter] = useState<SessionFilterValue>('all');
  const [sessionsOpen, setSessionsOpen] = useState(true);
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

  const createSession = useMutation({
    mutationFn: () => createProjectSession(projectId),
    onSuccess: (session) => {
      beginSessionTiming(session.session_id);
      sessionMark(session.session_id, 'session-created');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      prefetchSessionStart(queryClient, projectId, session.session_id);
      router.prefetch(`/projects/${projectId}/sessions/${session.session_id}`);
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
      if (isMobile) setOpenMobile(false);
    },
    onError: (err) => {
      if ((err as any)?.code === 'concurrent_session_limit') return;
      errorToast(err instanceof Error ? err.message : 'Failed to start session');
    },
  });

  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
    markSessionClick();
    createSession.mutate();
  }, [createSession]);

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
      collapsible="icon"
      variant="inset"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
        <div className="flex w-full items-center justify-between gap-2">
          <AnimatePresence initial={false} mode="popLayout">
            {isExpanded ? (
              <motion.div
                key="expanded-sidebar-header"
                initial={{ opacity: 0, x: -10, filter: 'blur(6px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, x: -8, filter: 'blur(6px)' }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                className="flex w-full items-center justify-between gap-0.5"
              >
                <div className="w-full min-w-0">
                  <ProjectSwitcher variant="sidebar" />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="collapsed-sidebar-header"
                initial={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }}
                transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
                className="flex w-full items-center justify-center"
                onMouseEnter={() => setIsHeaderHovered(true)}
                onMouseLeave={() => setIsHeaderHovered(false)}
              >
                {isHeaderHovered ? (
                  <SidebarTrigger />
                ) : (
                  <span className="py-2">
                    <KortixLogo
                      variant="symbol"
                      size={16}
                      className="text-muted-foreground size-8"
                    />
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </SidebarHeader>
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        <div
          className={cn(
            'flex h-full min-h-0 flex-col space-y-4',
            !isExpanded ? 'pointer-events-none opacity-0' : 'pointer-events-auto opacity-100',
          )}
        >
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  disabled={createSession.isPending}
                  size="md"
                  className="group/menu-button text-sidebar-foreground border-border dark:bg-background dark:hover:bg-background/90 bg-background hover:bg-background/90 flex items-center justify-center border-[1.2px] text-center !text-sm [&_svg]:!size-5"
                >
                  {createSession.isPending ? 'Creating…' : 'New session'}
                  <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
                    <Kbd>{modSymbol}</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            <Disclosure
              open={sessionsOpen}
              onOpenChange={setSessionsOpen}
              className="group/sessions flex min-h-0 flex-1 flex-col space-y-2"
              variants={{
                expanded: { height: '100%', opacity: 1 },
                collapsed: { height: 0, opacity: 0 },
              }}
            >
              <SidebarGroupLabel className="group/label text-muted-foreground/60 mt-1 flex h-6 items-center px-0 text-xs font-medium tracking-wider uppercase">
                <div className="flex w-full flex-row items-center gap-0.5">
                  <DropdownMenu>
                    <DisclosureTrigger>
                      <SidebarMenuButton
                        type="button"
                        className="flex-1 items-center justify-start px-2 text-[13px] font-normal hover:bg-transparent"
                      >
                        <span className="flex flex-row items-center gap-0.5">
                          <span>Sessions</span>
                          {sessionFilter !== 'all' && (
                            <span className="text-muted-foreground/90 truncate tracking-normal normal-case">
                              &bull; {activeFilterOption.label}
                            </span>
                          )}
                        </span>

                        <ChevronRight className="size-3 opacity-0 transition-transform duration-200 group-hover/label:opacity-100 group-data-[state=open]/sessions:rotate-90" />
                      </SidebarMenuButton>
                    </DisclosureTrigger>
                    <DropdownMenuContent align="start" className="w-44 p-1">
                      {SESSION_FILTER_OPTIONS.map((option) => {
                        const OptionIcon = SESSION_FILTER_ICONS[option.value];
                        return (
                          <DropdownMenuItem
                            key={option.value}
                            className="cursor-pointer"
                            onClick={() => setSessionFilter(option.value)}
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
                        aria-label="Toggle sessions"
                        className="text-muted-foreground/90 hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center px-2"
                      >
                        <HiDotsHorizontal className="size-3" />
                      </SidebarMenuButton>
                    </DropdownMenuTrigger>
                  </DropdownMenu>
                </div>
              </SidebarGroupLabel>
              <DisclosureContent
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
                contentClassName="flex h-full min-h-0 flex-col"
              >
                <ProjectSessionList projectId={projectId} filter={sessionFilter} />
              </DisclosureContent>
            </Disclosure>
          </SidebarGroup>

          <SidebarGroup className="mt-auto py-0.5">
            <SidebarMenu>
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              <ProjectAppsNavItem projectId={projectId} />
              <OnboardingSetupNavItem projectId={projectId} />
              <ProjectCustomizeNavItem />
            </SidebarMenu>
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter className="pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] group-data-[collapsible=icon]:px-0">
        <UserMenu user={user} variant="sidebar" />
      </SidebarFooter>
    </Sidebar>
  );
}
