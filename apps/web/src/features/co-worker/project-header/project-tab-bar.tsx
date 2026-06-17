'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Home, Menu, Share2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  SessionVisibilityBadge,
  ShareSessionModal,
} from '@/features/co-worker/project-sidebar/modal/share-session-modal';
import { useCloseProjectTab } from '@/hooks/projects/use-close-project-tab';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

interface ProjectTabBarProps {
  projectId: string;
}

function MobileSidebarTrigger() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const sidebar = useSidebar();
  return (
    <button
      type="button"
      onClick={() => sidebar.setOpenMobile(true)}
      className="text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground flex h-9 w-9 items-center justify-center rounded-md transition-colors"
      aria-label={tHardcodedUi.raw(
        'componentsProjectsProjectTabBar.line38JsxAttrAriaLabelOpenMenu',
      )}
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}

export function ProjectMobileMenuBar() {
  return (
    <div className="bg-sidebar flex h-[calc(38px+env(safe-area-inset-top,0px))] items-center pt-[env(safe-area-inset-top,0px)] pl-1.5 md:hidden">
      <MobileSidebarTrigger />
    </div>
  );
}

export function ProjectTabBar({ projectId }: ProjectTabBarProps) {
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
      className="bg-sidebar relative flex h-[calc(38px+env(safe-area-inset-top,0px))] flex-shrink-0 items-stretch overflow-hidden pt-[env(safe-area-inset-top,0px)]"
      role="tablist"
    >
      <div className="flex flex-shrink-0 items-center pr-1 pl-1.5 md:hidden">
        <MobileSidebarTrigger />
      </div>

      <div
        className={cn(
          'hidden flex-shrink-0 items-center gap-0.5 pr-1 md:flex',
          needsTrafficLightSpace ? 'pl-10' : 'pl-2',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => window.history.back()}
              className="text-muted-foreground/50 hover:text-muted-foreground flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Back
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => window.history.forward()}
              className="text-muted-foreground/50 hover:text-muted-foreground flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Forward
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => router.push(`/projects/${projectId}`)}
              className={cn(
                'ml-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors',
                isProjectHome
                  ? 'text-foreground'
                  : 'text-muted-foreground/50 hover:text-muted-foreground',
              )}
              aria-label="Project home"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Home
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-1 [scrollbar-width:'none'] items-stretch overflow-x-auto px-1 [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        {openTabIds.map((tabId) => {
          const isActive = isTabActive(tabId);
          const tabSession = sessionById.get(tabId);
          const label = tabSession
            ? sessionDisplayLabel(tabSession)
            : `session ${tabId.slice(0, 8)}`;

          return (
            <div
              key={tabId}
              role="tab"
              aria-selected={isActive}
              onClick={() => router.push(hrefForTab(tabId))}
              className={cn(
                'group relative flex cursor-pointer items-center text-xs select-none',
                'h-full transition-colors duration-150',
                'max-w-[200px] min-w-[96px] gap-1.5 px-2.5 md:min-w-[80px] md:gap-2 md:px-3',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className={cn('flex-1 truncate', isActive && 'font-medium')}>{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeProjectTab(tabId);
                }}
                className={cn(
                  'flex-shrink-0 cursor-pointer rounded-sm p-0.5 transition-colors duration-100',
                  'hover:bg-foreground/10',
                  isActive
                    ? 'opacity-60 md:opacity-40 md:hover:opacity-80'
                    : 'hidden md:block md:opacity-0 md:group-hover:opacity-40 md:group-hover:hover:opacity-80',
                )}
                aria-label={`Close ${label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>

              {isActive && (
                <div className="bg-foreground/80 absolute right-2 bottom-0 left-2 h-[2px] rounded-full" />
              )}
            </div>
          );
        })}
      </div>

      <div className="bg-sidebar relative z-20 flex h-full flex-shrink-0 items-center gap-1.5 pr-2 pl-1">
        {activeSession && (
          <>
            <SessionVisibilityBadge session={activeSession} />
            {activeSession.can_manage_sharing !== false && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setShareOpen(true)}
              >
                <Share2 className="h-3.5 w-3.5" />
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
