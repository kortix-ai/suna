'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  List,
  ListTree,
  Loader2,
  MessagesSquare,
  Slack,
  SlidersHorizontal,
  SquarePen,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  directSubsessions,
  matchesSessionFilter,
  SESSION_FILTER_OPTIONS,
  sessionDisplayLabel,
  type SessionFilterValue,
} from '@/components/projects/session-label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

import { ProjectAppsNavItem, ProjectAppsRailItem } from '@/components/projects/apps/apps-nav';
import {
  ProjectChangeRequestsNavItem,
  ProjectChangeRequestsRailItem,
} from '@/components/projects/change-requests-nav';
import { ProjectSessionList } from '@/components/projects/project-session-list';
import { ProjectSetupNavItem, ProjectSetupRailItem } from '@/components/projects/project-setup';
import {
  ProjectSandboxAlertNavItem,
  ProjectSandboxAlertRailItem,
} from '@/components/projects/sandbox-health-alert';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { ProjectSwitcher } from '@/features/layout/project-switcher';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { useAdminRole } from '@/hooks/admin';
import { useIsMobile } from '@/hooks/utils';
import { createProjectSession } from '@/lib/projects-client';
import { beginSessionTiming, markSessionClick, sessionMark } from '@/lib/session-timing';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

/** Hover-only keyboard hint chip used on the primary nav row. */
const SESSION_FILTER_ICONS: Record<SessionFilterValue, LucideIcon> = {
  all: List,
  mine: MessagesSquare,
  shared: Users,
  slack: Slack,
  schedule: CalendarClock,
  webhook: Webhook,
};

function KbdHint({ mod, letter }: { mod: string; letter: string }) {
  const chip =
    'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/40 bg-foreground/[0.05] px-1 text-xs font-medium leading-none text-muted-foreground/70 select-none';
  return (
    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/menu-button:opacity-100 group-data-[collapsible=icon]:hidden">
      <kbd className={chip}>{mod}</kbd>
      <kbd className={chip}>{letter}</kbd>
    </span>
  );
}

// ============================================================================
// Collapsed-state icon button — square hit target on the icon rail. The
// optional `flyoutContent` opens a portal panel to the right of the button
// on hover, used to expose the full session list while the sidebar is
// collapsed. Mirrors the pattern from main's sidebar-left so the project
// shell and the global shell feel identical when collapsed.
// ============================================================================

interface CollapsedIconButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  flyoutContent?: React.ReactNode;
  disabled?: boolean;
  isActive?: boolean;
}

function CollapsedIconButton({
  icon,
  label,
  onClick,
  flyoutContent,
  disabled,
  isActive,
}: CollapsedIconButtonProps) {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlyoutOpen(false), 180);
  }, []);
  const cancelClose = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (flyoutOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.top, left: r.right + 8 });
    }
  }, [flyoutOpen]);

  useEffect(() => {
    if (!flyoutOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyoutOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flyoutOpen]);

  useEffect(() => {
    if (!flyoutOpen) return;
    const onDown = (e: PointerEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        flyoutRef.current?.contains(e.target as Node)
      )
        return;
      setFlyoutOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [flyoutOpen]);

  const btnClass = cn(
    'flex items-center justify-center w-full py-2 rounded-lg cursor-pointer',
    'transition-colors duration-150 ease-out',
    isActive
      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
      : 'text-sidebar-foreground hover:bg-sidebar-accent',
    disabled && 'opacity-50 cursor-not-allowed',
  );

  if (flyoutContent) {
    return (
      <>
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={disabled}
          className={btnClass}
          onMouseEnter={() => {
            cancelClose();
            setFlyoutOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          {icon}
        </button>
        {flyoutOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={flyoutRef}
              style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 10001 }}
              className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-[0.98] slide-in-from-left-1 flex max-h-[60vh] w-[260px] flex-col overflow-hidden rounded-xl border shadow-lg duration-100"
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              {flyoutContent}
            </div>,
            document.body,
          )}
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button ref={btnRef} onClick={onClick} disabled={disabled} className={btnClass}>
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// ProjectSessionsFlyout — content for the collapsed Sessions hover flyout.
// Lists open project sessions; clicking one navigates to that session and
// also stamps it into the project's tab list (matches ProjectTabBar
// expectations).
// ============================================================================

function shortFlyoutRelative(text: string): string {
  return text
    .replace(/\sseconds?/, 's')
    .replace(/\sminutes?/, 'm')
    .replace(/\shours?/, 'h')
    .replace(/\sdays?/, 'd')
    .replace(/\smonths?/, 'mo')
    .replace(/\syears?/, 'y');
}

function ProjectSessionsFlyout({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const openTab = useProjectSessionTabsStore((s) => s.openTab);
  const activeOpenCodeSessionId = searchParams.get('oc');

  const { data, isLoading } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchInterval: (query) => {
      const sessions = query.state.data as ProjectSession[] | undefined;
      return (sessions ?? []).some((session) =>
        ['queued', 'branching', 'provisioning'].includes(session.status),
      )
        ? 5_000
        : false;
    },
    refetchOnWindowFocus: false,
  });

  const sessions = useMemo<ProjectSession[]>(() => {
    if (!data) return [];
    return [...data].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }, [data]);

  return (
    <div className="[scrollbar-width:none] overflow-y-auto py-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      {isLoading ? (
        <div className="text-muted-foreground px-3 py-6 text-center text-xs">
          {tHardcodedUi.raw('componentsProjectsProjectSidebar.line259JsxTextLoading')}
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-muted-foreground px-3 py-8 text-center text-xs">
          {tHardcodedUi.raw('componentsProjectsProjectSidebar.line261JsxTextNoSessionsYet')}
        </div>
      ) : (
        sessions.map((session) => {
          const href = `/projects/${projectId}/sessions/${session.session_id}`;
          const active = pathname?.startsWith(href) ?? false;
          const children = directSubsessions(session);
          const label = sessionDisplayLabel(session);
          const relative = (() => {
            try {
              return shortFlyoutRelative(
                formatDistanceToNowStrict(new Date(session.updated_at), { addSuffix: false }),
              );
            } catch {
              return '';
            }
          })();
          return (
            <div key={session.session_id}>
              <button
                onClick={() => {
                  openTab(projectId, session.session_id);
                  router.push(href);
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-100',
                  active && !activeOpenCodeSessionId
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                )}
              >
                <span className="flex-1 truncate text-left">{label}</span>
                {children.length > 0 && (
                  <span className="bg-sidebar-accent/60 text-muted-foreground rounded-full px-1.5 py-0.5 text-xs tabular-nums">
                    {children.length}
                  </span>
                )}
                {relative && (
                  <span className="text-muted-foreground/60 flex-shrink-0 text-xs tabular-nums">
                    {relative}
                  </span>
                )}
              </button>
              {children.length > 0 && active && (
                <div className="border-border/30 ml-4 border-l pl-1">
                  {children.map((child) => {
                    const childHref = `${href}?oc=${encodeURIComponent(child.id)}`;
                    const childActive = active && activeOpenCodeSessionId === child.id;
                    const childRelative = child.updated_at
                      ? shortFlyoutRelative(
                          formatDistanceToNowStrict(new Date(child.updated_at), {
                            addSuffix: false,
                          }),
                        )
                      : '';
                    return (
                      <button
                        key={child.id}
                        onClick={() => {
                          openTab(projectId, session.session_id);
                          router.push(childHref);
                        }}
                        className={cn(
                          'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-100',
                          childActive
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        )}
                      >
                        <span className="bg-muted-foreground/40 h-1 w-1 flex-shrink-0 rounded-full" />
                        <span className="flex-1 truncate text-left">
                          {child.title || 'Sub-session'}
                        </span>
                        {childRelative && (
                          <span className="text-muted-foreground/60 flex-shrink-0 text-xs tabular-nums">
                            {childRelative}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const effectiveState = isMobile ? 'expanded' : state;
  const queryClient = useQueryClient();

  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  // Session source filter — lives here so the SESSIONS header dropdown and the
  // list below stay in sync. Defaults to All (never hide sessions by default);
  // My Chats / Shared / Slack / Scheduled / Webhook narrow it down.
  const [sessionFilter, setSessionFilter] = useState<SessionFilterValue>('all');
  // Same query key as ProjectSessionList → shared cache, no extra fetch.
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

  // Pull identity from the AuthProvider (mounted once, well above this tree)
  // so navigating between project pages doesn't remount the sidebar onto a
  // "Loading…" placeholder while supabase.auth.getUser() resolves a second
  // time. That round-trip was the visible flicker on the footer widget.
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
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
      if (isMobile) setOpenMobile(false);
    },
    onError: (err) => {
      if ((err as any)?.code === 'concurrent_session_limit') return;
      toast.error(err instanceof Error ? err.message : 'Failed to start session');
    },
  });

  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
    markSessionClick();
    createSession.mutate();
  }, [createSession]);

  // CMD/CTRL+J — global project "new session" accelerator.
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

  // Customize is a full-screen overlay that floats over the active page
  // (driven by the customize store) — no route change, no tab. The button
  // just toggles it open, so you never lose your session/place.
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const customizeOpen = useCustomizeStore((s) => s.open);

  const goCustomize = useCallback(() => {
    openCustomize();
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      {/* ====================================================================
          HEADER — logo + collapse toggle, with the ProjectSwitcher pinned
          directly below. Account switching + user identity + settings live in
          the footer Account·You menu (see UserMenu).
         ==================================================================== */}
      <SidebarHeader className="pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-1">
        <div className="relative flex h-7 shrink-0 items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
          <Link
            href="/projects"
            className="flex items-center group-data-[collapsible=icon]:hidden"
            aria-label="Projects"
          >
            <KortixLogo variant="logomark" size={16} className="flex-shrink-0" />
          </Link>
          {/* Collapsed: clicking the logo expands the sidebar (no nav). The
              symbol swaps to a chevron on hover to signal "expand". */}
          {effectiveState === 'collapsed' && (
            <button
              type="button"
              className="group/collapsed absolute inset-0 flex cursor-pointer items-center justify-center"
              onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}
              aria-label="Expand sidebar"
            >
              <span className="flex items-center justify-center group-hover/collapsed:hidden">
                <KortixLogo variant="symbol" size={20} className="flex-shrink-0" />
              </span>
              <ChevronRight className="text-sidebar-foreground hidden h-3.5 w-3.5 group-hover/collapsed:block" />
            </button>
          )}
          <button
            type="button"
            onClick={() => (isMobile ? setOpenMobile(false) : setOpen(false))}
            aria-label={isMobile ? 'Close menu' : 'Collapse sidebar'}
            className={cn(
              'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground flex items-center justify-center rounded-md transition-colors duration-150',
              isMobile ? 'h-8 w-8' : 'h-6 w-6',
              effectiveState === 'collapsed' && 'hidden',
            )}
          >
            {isMobile ? <X className="h-4 w-4" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
        </div>
        {/* Project selector stays visible when collapsed — ProjectSwitcher
            renders avatar-only + centered in the icon rail (label/chevron
            self-hide via its own group-data-[collapsible=icon] classes). */}
        <div className="pt-2">
          <ProjectSwitcher variant="sidebar" />
        </div>
      </SidebarHeader>

      {/* ====================================================================
          CONTENT — three groups in vertical order:
            1. Primary action  (New session)              — top, "compose" slot
            2. Sessions        (collapsible, flex-1)      — takes remaining space
            3. Project nav     (Files, Secrets, Settings) — pinned just above the
                                                            workspace footer so
                                                            utility actions live
                                                            consistently at the
                                                            bottom of the sidebar.
         ==================================================================== */}
      <SidebarContent className="relative [scrollbar-width:'none'] overflow-visible [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        {/* --- Collapsed: icon rail. Absolute layer toggled by opacity so
            no text/kbd-hint from the expanded layer bleeds through.
            Mirrors apps/web/.../sidebar-left.tsx on main. --- */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col items-center px-2 pt-1 pb-1',
            effectiveState === 'collapsed'
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0',
          )}
        >
          <div className="w-full space-y-0.5">
            <CollapsedIconButton
              icon={
                createSession.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SquarePen className="h-4 w-4" />
                )
              }
              label={tHardcodedUi.raw(
                'componentsProjectsProjectSidebar.line510JsxAttrLabelNewSession',
              )}
              onClick={handleNewSession}
              disabled={createSession.isPending}
            />
            <CollapsedIconButton
              icon={<ListTree className="h-4 w-4" />}
              label="Sessions"
              onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}
              flyoutContent={<ProjectSessionsFlyout projectId={projectId} />}
            />
          </div>
          {/* Customize pinned to the bottom — opens the full-screen
              modal that houses Files, Skills, Agents, and the rest of
              the per-project config surfaces. */}
          <div className="mt-auto w-full space-y-0.5">
            <ProjectSandboxAlertRailItem projectId={projectId} />
            <ProjectChangeRequestsRailItem projectId={projectId} />
            <ProjectAppsRailItem projectId={projectId} />
            <ProjectSetupRailItem projectId={projectId} />
            <CollapsedIconButton
              icon={<SlidersHorizontal className="h-4 w-4" />}
              label="Customize"
              onClick={goCustomize}
              isActive={customizeOpen}
            />
          </div>
        </div>

        {/* --- Expanded layout --- */}
        <div
          className={cn(
            'flex h-full min-h-0 flex-col gap-0',
            effectiveState === 'collapsed'
              ? 'pointer-events-none opacity-0'
              : 'pointer-events-auto opacity-100',
          )}
        >
          {/* — Primary action — */}
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  disabled={createSession.isPending}
                  className="group/menu-button !text-sm font-normal [&_svg]:!size-4"
                >
                  {createSession.isPending ? <Loader2 className="animate-spin" /> : <SquarePen />}
                  <span>{createSession.isPending ? 'Creating…' : 'New session'}</span>
                  <KbdHint mod={modSymbol} letter="J" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          {/* — Sessions — fills remaining space. */}
          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            <Collapsible
              defaultOpen
              className="group/sessions flex min-h-0 flex-col data-[state=open]:flex-1"
            >
              <SidebarGroupLabel className="group/label text-muted-foreground/60 mt-1 flex h-6 items-center gap-2 px-2 text-xs font-medium tracking-wider uppercase">
                {/* Label opens the filter menu; the chevron keeps collapse. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="hover:text-sidebar-foreground flex flex-1 cursor-pointer items-center gap-1.5 text-left tracking-wider uppercase"
                    >
                      <span>Sessions</span>
                      {sessionFilter !== 'all' && (
                        <span className="text-muted-foreground/50 truncate tracking-normal normal-case">
                          · {activeFilterOption.label}
                        </span>
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44 p-1">
                    {SESSION_FILTER_OPTIONS.map((option) => {
                      const OptionIcon = SESSION_FILTER_ICONS[option.value];
                      const isActiveOption = sessionFilter === option.value;
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
                            {isActiveOption && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    aria-label="Toggle sessions"
                    className="text-muted-foreground/60 hover:text-sidebar-foreground cursor-pointer"
                  >
                    <ChevronDown className="size-3 transition-transform duration-200 group-data-[state=closed]/sessions:-rotate-90" />
                  </button>
                </CollapsibleTrigger>
              </SidebarGroupLabel>
              <CollapsibleContent className="min-h-0 [scrollbar-width:none] [-ms-overflow-style:none] data-[state=open]:flex-1 data-[state=open]:overflow-y-auto [&::-webkit-scrollbar]:hidden">
                <ProjectSessionList projectId={projectId} filter={sessionFilter} />
              </CollapsibleContent>
            </Collapsible>
          </SidebarGroup>

          {/* — Project nav — pinned just above the workspace footer. The
              single Customize button opens a full-screen modal with Files,
              Skills, Agents, and every other per-project config surface. */}
          <SidebarGroup className="mt-auto py-0">
            <SidebarMenu>
              <ProjectSandboxAlertNavItem projectId={projectId} />
              <ProjectChangeRequestsNavItem projectId={projectId} />
              <ProjectAppsNavItem projectId={projectId} />
              <ProjectSetupNavItem projectId={projectId} />
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={goCustomize}
                  isActive={customizeOpen}
                  className="transform-none !text-sm font-normal !transition-none data-[active=true]:font-normal [&_svg]:!size-4"
                >
                  <SlidersHorizontal />
                  <span>Customize</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </div>
      </SidebarContent>

      {/* ====================================================================
          FOOTER — the "you" menu: identity, Home, user settings, theme, log
          out. Account switching lives in the breadcrumb <AccountSwitcher>
          (you don't change account mid-project); which project is the
          ProjectSwitcher at the top.
         ==================================================================== */}
      <SidebarFooter className="pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] group-data-[collapsible=icon]:px-0">
        <UserMenu user={user} variant="sidebar" />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
