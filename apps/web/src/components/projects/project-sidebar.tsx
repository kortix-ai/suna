'use client';

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronDown,
  SquarePen,
  FileText,
  Loader2,
  SlidersHorizontal,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { UserMenu } from '@/components/sidebar/user-menu';
import { ProjectSelector } from '@/components/projects/project-selector';
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
    'inline-flex items-center justify-center size-5 rounded-md bg-foreground/[0.06] border border-border/40 text-[10px] font-medium text-muted-foreground/70 leading-none font-sans select-none';
  return (
    <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/menu-button:opacity-100 group-data-[collapsible=icon]:hidden">
      <kbd className={chip}>{mod}</kbd>
      <kbd className={chip}>{letter}</kbd>
    </span>
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

  const filesActive = pathname?.startsWith(`/projects/${projectId}/files`) ?? false;
  // Customize covers the whole route group: agents, skills, secrets, triggers,
  // channels, connectors, settings. Any of those should light up the sidebar
  // button so the user knows where they are.
  const CUSTOMIZE_SECTIONS = [
    'agents',
    'skills',
    'commands',
    'secrets',
    'schedules',
    'webhooks',
    'channels',
    'connectors',
    'settings',
  ];
  const customizeActive = CUSTOMIZE_SECTIONS.some((slug) =>
    pathname?.startsWith(`/projects/${projectId}/${slug}`),
  );

  const goFiles = useCallback(() => {
    router.push(`/projects/${projectId}/files`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);

  // Customize defaults to /agents — that's the first section in the
  // secondary nav. Last-visited memory could come later; for now a stable
  // default beats route surprise.
  const goCustomize = useCallback(() => {
    router.push(`/projects/${projectId}/agents`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
    >
      {/* ====================================================================
          HEADER — logo + collapse toggle, with the ProjectSelector
          (account / project switcher only) pinned directly below.
          User identity + settings live in the footer (see UserMenu).
         ==================================================================== */}
      <SidebarHeader className="pb-1 pt-3">
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
            aria-label="Collapse sidebar"
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground',
              effectiveState === 'collapsed' && 'hidden',
            )}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="pt-2 group-data-[collapsible=icon]:px-0">
          <ProjectSelector />
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
      <SidebarContent className="gap-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] overflow-visible">
        {/* — Primary action — */}
        <SidebarGroup className="py-0">
          <SidebarMenu>
            <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <SidebarMenuButton
                onClick={handleNewSession}
                disabled={createSession.isPending}
                tooltip={`New session  ${modSymbol}J`}
                className="group/menu-button"
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

        {/* — Sessions — fills remaining space. Hidden when collapsed (icon
            rail keeps the rest visible). */}
        <SidebarGroup
          className="min-h-0 flex-1 flex-col py-0 group-data-[collapsible=icon]:hidden"
          ref={sessionsGroupRef}
        >
          <Collapsible
            defaultOpen
            className="group/sessions flex min-h-0 flex-col data-[state=open]:flex-1"
          >
            <CollapsibleTrigger asChild>
              <SidebarGroupLabel className="group/label flex h-7 cursor-pointer items-center gap-2 px-2 mt-1 text-[11px] font-medium text-muted-foreground/60 hover:text-sidebar-foreground">
                <span className="flex-1 text-left">Sessions</span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=closed]/sessions:-rotate-90" />
              </SidebarGroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent className="min-h-0 data-[state=open]:flex-1 data-[state=open]:overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <ProjectSessionList projectId={projectId} />
            </CollapsibleContent>
          </Collapsible>
        </SidebarGroup>

        {/* — Project nav — pinned at the bottom of the content stack,
            just above the workspace footer. */}
        <SidebarGroup className="py-0 mt-auto">
          <SidebarMenu>
            <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <SidebarMenuButton
                onClick={goFiles}
                isActive={filesActive}
                tooltip="Files"
              >
                <FileText />
                <span>Files</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <SidebarMenuButton
                onClick={goCustomize}
                isActive={customizeActive}
                tooltip="Customize"
              >
                <SlidersHorizontal />
                <span>Customize</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* ====================================================================
          FOOTER — user identity + settings + theme + log out. Kept
          separate from the ProjectSelector at the top so the two concerns
          (which project am I in vs. who am I) don't share one widget.
         ==================================================================== */}
      <SidebarFooter className="pb-2 pt-1 group-data-[collapsible=icon]:px-0">
        <UserMenu user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
