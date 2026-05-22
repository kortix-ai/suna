'use client';

import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronDown,
  SquarePen,
  Loader2,
  SlidersHorizontal,
  ListTree,
  X,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { UserMenu } from '@/components/layout/user-menu';
import { ProjectSwitcher } from '@/components/layout/project-switcher';
import { ProjectSessionList } from '@/components/projects/project-session-list';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useAdminRole } from '@/hooks/admin';
import { useAuth } from '@/components/AuthProvider';
import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

/** Hover-only keyboard hint chip used on the primary nav row. */
function KbdHint({ mod, letter }: { mod: string; letter: string }) {
  const chip =
    'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded bg-foreground/[0.05] border border-border/40 text-[9.5px] font-medium text-muted-foreground/70 leading-none font-sans select-none';
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
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (flyoutOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.top, left: r.right + 8 });
    }
  }, [flyoutOpen]);

  useEffect(() => {
    if (!flyoutOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlyoutOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flyoutOpen]);

  useEffect(() => {
    if (!flyoutOpen) return;
    const onDown = (e: PointerEvent) => {
      if (btnRef.current?.contains(e.target as Node) || flyoutRef.current?.contains(e.target as Node)) return;
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
          onMouseEnter={() => { cancelClose(); setFlyoutOpen(true); }}
          onMouseLeave={scheduleClose}
        >
          {icon}
        </button>
        {flyoutOpen && typeof document !== 'undefined' && createPortal(
          <div
            ref={flyoutRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 10001 }}
            className="w-[260px] max-h-[60vh] overflow-hidden flex flex-col rounded-xl border bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-[0.98] slide-in-from-left-1 duration-100"
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
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={disabled}
          className={btnClass}
        >
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
  const pathname = usePathname();
  const router = useRouter();
  const openTab = useProjectSessionTabsStore((s) => s.openTab);

  const { data, isLoading } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: 5000,
  });

  const sessions = useMemo<ProjectSession[]>(() => {
    if (!data) return [];
    return [...data].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }, [data]);

  return (
    <div className="overflow-y-auto py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      {isLoading ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">No sessions yet</div>
      ) : (
        sessions.map((session) => {
          const href = `/projects/${projectId}/sessions/${session.session_id}`;
          const active = pathname?.startsWith(href) ?? false;
          const metadataName =
            typeof session.metadata?.session_name === 'string'
              ? (session.metadata.session_name as string)
              : null;
          const fallback = session.branch_name
            ? session.branch_name.slice(0, 14)
            : session.session_id.slice(0, 8);
          const label = metadataName?.trim() || fallback;
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
            <button
              key={session.session_id}
              onClick={() => {
                openTab(projectId, session.session_id);
                router.push(href);
              }}
              className={cn(
                'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] cursor-pointer transition-colors duration-100',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              <span className="flex-1 truncate text-left">{label}</span>
              {relative && (
                <span className="flex-shrink-0 text-[9.5px] tabular-nums text-muted-foreground/60">
                  {relative}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const effectiveState = isMobile ? 'expanded' : state;
  const queryClient = useQueryClient();

  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  // Pull identity from the AuthProvider (mounted once, well above this tree)
  // so navigating between project pages doesn't remount the sidebar onto a
  // "Loading…" placeholder while supabase.auth.getUser() resolves a second
  // time. That round-trip was the visible flicker on the footer widget.
  const { user: authUser } = useAuth();
  const user = useMemo(
    () => ({
      name:
        authUser?.user_metadata?.name ||
        authUser?.email?.split('@')[0] ||
        'User',
      email: authUser?.email ?? '',
      avatar:
        authUser?.user_metadata?.avatar_url ||
        authUser?.user_metadata?.picture ||
        '',
      isAdmin,
    }),
    [authUser, isAdmin],
  );

  const createSession = useMutation({
    mutationFn: () => createProjectSession(projectId),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
      if (isMobile) setOpenMobile(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start session');
    },
  });

  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
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

  // Customize lives as a dedicated tab next to the project sessions. We
  // track an "open" flag in the same per-project store the session tabs
  // use so the tab bar can render it consistently, and clicking the
  // sidebar button both opens the tab and routes to /customize.
  const openCustomizeTab = useProjectSessionTabsStore((s) => s.openCustomizeTab);
  const isCustomizeRoute =
    pathname?.startsWith(`/projects/${projectId}/customize`) ?? false;

  const goCustomize = useCallback(() => {
    openCustomizeTab(projectId);
    router.push(`/projects/${projectId}/customize`);
    if (isMobile) setOpenMobile(false);
  }, [openCustomizeTab, router, projectId, isMobile, setOpenMobile]);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
    >
      {/* ====================================================================
          HEADER — logo + collapse toggle, with the ProjectSwitcher pinned
          directly below. Account switching + user identity + settings live in
          the footer Account·You menu (see UserMenu).
         ==================================================================== */}
      <SidebarHeader className="pb-1 pt-[max(0.75rem,env(safe-area-inset-top,0px))]">
        <div className="flex h-7 shrink-0 items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
          <Link
            href="/projects"
            className="flex items-center group-data-[collapsible=icon]:hidden"
            aria-label="Projects"
          >
            <KortixLogo variant="logomark" size={16} className="flex-shrink-0" />
          </Link>
          <Link
            href="/projects"
            className="hidden items-center group-data-[collapsible=icon]:flex"
            aria-label="Projects"
          >
            <KortixLogo variant="symbol" size={20} className="flex-shrink-0" />
          </Link>
          <button
            type="button"
            onClick={() => (isMobile ? setOpenMobile(false) : setOpen(false))}
            aria-label={isMobile ? 'Close menu' : 'Collapse sidebar'}
            className={cn(
              'flex items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground',
              isMobile ? 'h-8 w-8' : 'h-6 w-6',
              effectiveState === 'collapsed' && 'hidden',
            )}
          >
            {isMobile ? (
              <X className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="pt-2 group-data-[collapsible=icon]:hidden">
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
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] relative overflow-visible">
        {/* --- Collapsed: icon rail. Absolute layer toggled by opacity so
            no text/kbd-hint from the expanded layer bleeds through.
            Mirrors apps/web/.../sidebar-left.tsx on main. --- */}
        <div className={cn(
          'absolute inset-0 px-2 pt-1 pb-1 flex flex-col items-center',
          effectiveState === 'collapsed' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}>
          <div className="w-full space-y-0.5">
            <CollapsedIconButton
              icon={createSession.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <SquarePen className="h-4 w-4" />}
              label="New session"
              onClick={handleNewSession}
              disabled={createSession.isPending}
            />
            <CollapsedIconButton
              icon={<ListTree className="h-4 w-4" />}
              label="Sessions"
              flyoutContent={<ProjectSessionsFlyout projectId={projectId} />}
            />
          </div>
          {/* Customize pinned to the bottom — opens the full-screen
              modal that houses Files, Skills, Agents, and the rest of
              the per-project config surfaces. */}
          <div className="mt-auto w-full space-y-0.5">
            <CollapsedIconButton
              icon={<SlidersHorizontal className="h-4 w-4" />}
              label="Customize"
              onClick={goCustomize}
              isActive={isCustomizeRoute}
            />
          </div>
        </div>

        {/* --- Expanded layout --- */}
        <div className={cn(
          'flex flex-col h-full min-h-0 gap-0',
          effectiveState === 'collapsed' ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto',
        )}>
          {/* — Primary action — */}
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  disabled={createSession.isPending}
                  className="group/menu-button !text-[12.5px] font-normal [&_svg]:!size-4"
                >
                  {createSession.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <SquarePen />
                  )}
                  <span>{createSession.isPending ? 'Creating…' : 'New session'}</span>
                  <KbdHint mod={modSymbol} letter="J" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          {/* — Sessions — fills remaining space. */}
          <SidebarGroup
            className="min-h-0 flex-1 flex-col py-0"
            ref={sessionsGroupRef}
          >
            <Collapsible
              defaultOpen
              className="group/sessions flex min-h-0 flex-col data-[state=open]:flex-1"
            >
              <CollapsibleTrigger asChild>
                <SidebarGroupLabel className="group/label flex h-6 cursor-pointer items-center gap-2 px-2 mt-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/60 hover:text-sidebar-foreground">
                  <span className="flex-1 text-left">Sessions</span>
                  <ChevronDown className="size-3 transition-transform duration-200 group-data-[state=closed]/sessions:-rotate-90" />
                </SidebarGroupLabel>
              </CollapsibleTrigger>
              <CollapsibleContent className="min-h-0 data-[state=open]:flex-1 data-[state=open]:overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                <ProjectSessionList projectId={projectId} />
              </CollapsibleContent>
            </Collapsible>
          </SidebarGroup>

          {/* — Project nav — pinned just above the workspace footer. The
              single Customize button opens a full-screen modal with Files,
              Skills, Agents, and every other per-project config surface. */}
          <SidebarGroup className="py-0 mt-auto">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={goCustomize}
                  isActive={isCustomizeRoute}
                  className="!text-[12.5px] font-normal data-[active=true]:font-normal !transition-none transform-none [&_svg]:!size-4"
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
      <SidebarFooter className="pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] pt-1 group-data-[collapsible=icon]:px-0">
        <UserMenu user={user} variant="sidebar" />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
