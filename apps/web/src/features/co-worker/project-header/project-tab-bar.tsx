'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import {
  SessionVisibilityBadge,
  ShareSessionModal,
} from '@/features/co-worker/project-sidebar/modal/share-session-modal';
import { Icon } from '@/features/icon/icon';
import { useCloseProjectTab } from '@/hooks/projects/use-close-project-tab';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { HomeSolid, Share } from '@mynaui/icons-react';
import Link from 'next/link';

function ProjectSessionTab({
  tabId,
  label,
  isActive,
  href,
  onClose,
}: {
  tabId: string;
  label: string;
  isActive: boolean;
  href: string;
  onClose: (tabId: string) => void;
}) {
  return (
    <Button
      type="button"
      role="tab"
      size="sm"
      aria-selected={isActive}
      variant={isActive ? 'secondary' : 'ghost'}
      className={cn(
        'group relative max-w-[170px] min-w-[96px] text-xs md:min-w-[80px]',
        !isActive && 'text-muted-foreground',
      )}
      asChild
    >
      <Link href={href}>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left transition-all duration-150',
            'group-hover:mask-r-from-8',
            isActive && 'font-medium',
          )}
        >
          {label}
        </span>
        <Button
          type="button"
          variant="background"
          size="icon-xs"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose(tabId);
          }}
          className={cn(
            'absolute top-1/2 right-2 size-5.5 -translate-y-1/2 p-0',
            'pointer-events-none scale-75 opacity-0',
            'transition-all duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
            'group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100',
            'overflow-hidden rounded-full',
          )}
          aria-label={`Close ${label}`}
        >
          <div className="absolute inset-0 bg-black/20" />
          <Icon.Close className="size-3.5" />
        </Button>
      </Link>
    </Button>
  );
}

export function ProjectTabBar({
  projectId,
  hideTabSelector = false,
}: {
  projectId: string;
  hideTabSelector?: boolean;
}) {
  const sidebar = useSidebar();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  const tabsByProject = useProjectSessionTabsStore((s) => s.tabsByProject);
  const openTab = useProjectSessionTabsStore((s) => s.openTab);
  const optimisticActive = useProjectSessionTabsStore(
    (s) => s.optimisticActiveByProject[projectId] ?? null,
  );
  const setOptimisticActive = useProjectSessionTabsStore((s) => s.setOptimisticActive);
  const openTabIds = useMemo(() => tabsByProject[projectId] ?? [], [tabsByProject, projectId]);
  const isProjectHome = pathname === `/projects/${projectId}`;

  const effectiveActiveId = optimisticActive ?? activeSessionId;
  const closeProjectTab = useCloseProjectTab(projectId);

  useEffect(() => {
    if (activeSessionId) openTab(projectId, activeSessionId);
  }, [projectId, activeSessionId, openTab]);

  useEffect(() => {
    if (optimisticActive !== null) {
      setOptimisticActive(projectId, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const queryClient = useQueryClient();

  useEffect(() => {
    openTabIds.forEach((id) => {
      router.prefetch(`/projects/${projectId}/sessions/${id}`);
    });
  }, [openTabIds, projectId, router]);

  const { data: sessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const sessionById = useMemo(() => {
    const map = new Map<string, ProjectSession>();
    (sessions ?? []).forEach((s) => map.set(s.session_id, s));
    return map;
  }, [sessions]);

  const [shareOpen, setShareOpen] = useState(false);
  const activeSession = activeSessionId ? (sessionById.get(activeSessionId) ?? null) : null;

  const [isMacDesktop, setIsMacDesktop] = useState(false);
  useEffect(() => {
    setIsMacDesktop(isDesktop() && desktopPlatform() === 'macos');
  }, []);
  const needsTrafficLightSpace = isMacDesktop && sidebar.state === 'collapsed';

  const hrefForTab = (id: string) => `/projects/${projectId}/sessions/${id}`;

  const isTabActive = (id: string) => effectiveActiveId === id;

  return (
    <div
      className="bg-sidebar relative flex min-w-0 flex-1 items-stretch overflow-hidden px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))] lg:pr-2 lg:pl-0"
      role="tablist"
    >
      <div className="flex shrink-0 items-center px-1.5">
        <div className="flex items-center md:hidden">
          <SidebarTrigger />
        </div>
        <Button
          type="button"
          variant={isProjectHome ? 'secondary' : 'ghost'}
          size="icon"
          className="shrink-0"
          asChild
        >
          <Link href={`/projects/${projectId}`}>
            <HomeSolid className="size-4.5" />
          </Link>
        </Button>
      </div>

      {!hideTabSelector && (
        <FadedScrollArea
          orientation="horizontal"
          fadeColor="from-sidebar"
          className="min-w-0 flex-1 items-stretch px-1"
        >
          <div className="flex items-stretch gap-1">
            {openTabIds.map((tabId) => {
              const isActive = isTabActive(tabId);
              const tabSession = sessionById.get(tabId);
              const label = tabSession
                ? sessionDisplayLabel(tabSession)
                : `session ${tabId.slice(0, 8)}`;

              return (
                <ProjectSessionTab
                  key={tabId}
                  tabId={tabId}
                  label={label}
                  isActive={isActive}
                  href={hrefForTab(tabId)}
                  onClose={closeProjectTab}
                />
              );
            })}
          </div>
        </FadedScrollArea>
      )}

      <div
        className={cn(
          'bg-sidebar relative z-20 flex h-full shrink-0 items-center gap-1.5',
          hideTabSelector && 'ml-auto',
        )}
      >
        {activeSession && (
          <>
            <SessionVisibilityBadge session={activeSession} />
            {activeSession.can_manage_sharing !== false && (
              <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)}>
                <Share className="size-3.5" />
                Share
              </Button>
            )}
          </>
        )}
      </div>

      <ShareSessionModal
        projectId={projectId}
        session={activeSession}
        open={shareOpen}
        onOpenChange={setShareOpen}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] })}
      />
    </div>
  );
}
