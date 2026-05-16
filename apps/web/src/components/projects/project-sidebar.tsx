'use client';

import * as React from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronDown,
  SquarePen,
  FileText,
  KeyRound,
  Settings,
  Loader2,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { WorkspaceMenu } from '@/components/sidebar/workspace-menu';
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
import { createClient } from '@/lib/supabase/client';
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

  const [user, setUser] = useState<{
    name: string;
    email: string;
    avatar: string;
    isAdmin?: boolean;
  }>({ name: 'Loading...', email: '', avatar: '', isAdmin: false });

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        setUser({
          name:
            data.user.user_metadata?.name ||
            data.user.email?.split('@')[0] ||
            'User',
          email: data.user.email || '',
          avatar:
            data.user.user_metadata?.avatar_url ||
            data.user.user_metadata?.picture ||
            '',
          isAdmin,
        });
      }
    })();
  }, [isAdmin]);

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
  const secretsActive = pathname?.startsWith(`/projects/${projectId}/secrets`) ?? false;
  const settingsActive = pathname?.startsWith(`/projects/${projectId}/settings`) ?? false;

  const goFiles = useCallback(() => {
    router.push(`/projects/${projectId}/files`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);

  const goSecrets = useCallback(() => {
    router.push(`/projects/${projectId}/secrets`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);

  const goSettings = useCallback(() => {
    router.push(`/projects/${projectId}/settings`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
    >
      {/* ====================================================================
          HEADER — logo + collapse toggle only. Workspace context (account,
          project, identity, settings) is consolidated in the footer's
          WorkspaceMenu (Cursor/Notion-style single widget).
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
                onClick={goSecrets}
                isActive={secretsActive}
                tooltip="Secrets"
              >
                <KeyRound />
                <span>Secrets</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <SidebarMenuButton
                onClick={goSettings}
                isActive={settingsActive}
                tooltip="Settings"
              >
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* ====================================================================
          FOOTER — single WorkspaceMenu carries identity + workspace context
          (account + project) + settings + theme + log out.

          In the icon rail (collapsed) we drop horizontal padding so the
          avatar centers cleanly against the 52px rail — matches the legacy
          /instances sidebar.
         ==================================================================== */}
      <SidebarFooter className="pb-2 pt-1 group-data-[collapsible=icon]:px-0">
        <WorkspaceMenu user={user} variant="sidebar" />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
