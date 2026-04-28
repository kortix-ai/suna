'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FolderGit2,
  MessageSquareText,
  FolderOpen,
  Search,
  Sparkles,
  PanelLeft,
  PanelLeftClose,
  Loader2,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  getCurrentInstanceIdFromPathname,
  getActiveInstanceIdFromCookie,
  toInstanceAwarePath,
  normalizeAppPathname,
} from '@/lib/instance-routes';
import { createClient } from '@/lib/supabase/client';
import { useAdminRole } from '@/hooks/admin';
import { useKortixProjects, type KortixProject } from '@/hooks/kortix/use-kortix-projects';
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { ProjectIcon } from '@/components/kortix/project-icon';
import { SessionList } from '@/components/sidebar/session-list';
import { KortixLogo } from './kortix-logo';
import { UserMenu } from './user-menu';
import {
  SidebarActionItem,
  SidebarLinkItem,
  SidebarCollapsibleGroup,
  SidebarSubLink,
  SidebarGroupBody,
  SidebarGroupEmpty,
  SidebarMenu,
} from './new-sidebar-items';

export function NewSidebarLeft({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === 'collapsed';

  const instanceId = useMemo(
    () => getCurrentInstanceIdFromPathname(pathname) || getActiveInstanceIdFromCookie(),
    [pathname],
  );
  const normalized = normalizeAppPathname(pathname);
  const buildHref = useCallback(
    (href: string) => toInstanceAwarePath(href, instanceId),
    [instanceId],
  );

  const user = useUserDisplay();
  const isMac = useIsMac();

  const openCommandPalette = useCallback(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, [isMac]);

  const createSession = useCreateOpenCodeSession();
  const handleNewSession = useCallback(async () => {
    try {
      const session = await createSession.mutateAsync();
      router.push(buildHref(`/sessions/${session.id}`));
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('focus-session-textarea'));
      });
    } catch {
      router.push(buildHref('/dashboard'));
    }
  }, [createSession, router, buildHref]);

  const { data: projectsData } = useKortixProjects();
  const projects = useMemo<KortixProject[]>(() => {
    if (!projectsData || !Array.isArray(projectsData)) return [];
    return [...projectsData].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [projectsData]);

  const isFilesActive = normalized === '/files' || normalized.startsWith('/files/');
  const isSessionsActive = normalized === '/sessions' || normalized.startsWith('/sessions/');
  const isProjectsActive =
    normalized === '/dashboard' || normalized === '/projects' || normalized.startsWith('/projects/');
  const activeProjectId = useMemo(() => {
    const m = normalized.match(/^\/projects\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, [normalized]);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="p-2">
        <div className="flex h-8 items-center gap-2">
          <Link
            href={buildHref('/dashboard')}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-muted/60 group-data-[collapsible=icon]:hidden"
            aria-label="Kortix home"
          >
            <KortixLogo size={14} variant="logomark" />
          </Link>
          <button
            type="button"
            onClick={toggleSidebar}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground group-data-[collapsible=icon]:mx-auto"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (⌘B)`}
          >
            {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0 px-2 pt-3">
        <SidebarMenu>
          <SidebarActionItem
            icon={Search}
            label="Search"
            kbd="⌘K"
            onClick={openCommandPalette}
          />
          <SidebarActionItem
            icon={Sparkles}
            label="New chat"
            kbd="⌘J"
            onClick={handleNewSession}
            loading={createSession.isPending}
            loadingIcon={<Loader2 className="animate-spin" />}
          />
        </SidebarMenu>

        <SidebarMenu>
          <SidebarLinkItem
            icon={FolderOpen}
            label="Files"
            href={buildHref('/files')}
            isActive={isFilesActive}
          />
        </SidebarMenu>

        <SidebarCollapsibleGroup
          id="projects"
          icon={FolderGit2}
          label="Projects"
          count={projects.length}
          defaultOpen
          isActive={isProjectsActive}
        >
          <SidebarGroupBody>
            {projects.length === 0 ? (
              <SidebarGroupEmpty>No projects yet</SidebarGroupEmpty>
            ) : (
              projects.slice(0, 12).map((project) => (
                <SidebarSubLink
                  key={project.id}
                  href={buildHref(`/projects/${encodeURIComponent(project.id)}`)}
                  isActive={activeProjectId === project.id}
                  indicator={<ProjectIcon project={project} size="xs" />}
                  label={project.name}
                />
              ))
            )}
          </SidebarGroupBody>
        </SidebarCollapsibleGroup>

        <SidebarCollapsibleGroup
          id="sessions"
          icon={MessageSquareText}
          label="Sessions"
          defaultOpen={false}
          isActive={isSessionsActive}
          scrollable
        >
          <div className="ml-3 border-l border-border/40 pl-1">
            <SessionList projectId={null} />
          </div>
        </SidebarCollapsibleGroup>

        {/* Collapsed-rail fallback for the surfaces hidden behind groups */}
        <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
          <SidebarLinkItem
            icon={FolderGit2}
            label="Projects"
            href={buildHref('/dashboard')}
            isActive={isProjectsActive}
          />
          <SidebarLinkItem
            icon={MessageSquareText}
            label="Sessions"
            href={buildHref('/sessions')}
            isActive={isSessionsActive}
          />
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <UserMenu user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}

function useUserDisplay() {
  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;
  const [user, setUser] = useState<{
    name: string;
    email: string;
    avatar: string;
    isAdmin?: boolean;
  }>({ name: 'Loading…', email: '', avatar: '', isAdmin: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;
      setUser({
        name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
        email: data.user.email || '',
        avatar:
          data.user.user_metadata?.avatar_url ||
          data.user.user_metadata?.picture ||
          '',
        isAdmin,
      });
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  return user;
}

function useIsMac() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac/.test(navigator.userAgent));
  }, []);
  return isMac;
}
