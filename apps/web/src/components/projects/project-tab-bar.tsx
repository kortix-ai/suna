'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Menu, SlidersHorizontal, X } from 'lucide-react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSidebar } from '@/components/ui/sidebar';
import { isDesktop, desktopPlatform } from '@/lib/desktop';
import { listProjectSessions, type ProjectSession } from '@/lib/projects-client';
import {
  useProjectSessionTabsStore,
  CUSTOMIZE_TAB_ID,
} from '@/stores/project-session-tabs-store';

interface ProjectTabBarProps {
  projectId: string;
}

/**
 * Hamburger that opens the project sidebar drawer on touch. The project
 * shell has no global right rail (per-session panels are toggled from the
 * session header), so this is the single mobile entry into the sidebar.
 */
function MobileSidebarTrigger() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const sidebar = useSidebar();
  return (
    <button
      type="button"
      onClick={() => sidebar.setOpenMobile(true)}
      className="flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      aria-label={tHardcodedUi.raw('componentsProjectsProjectTabBar.line38JsxAttrAriaLabelOpenMenu')}
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}

/**
 * Slim mobile-only bar used when the tab selector is disabled. Without it,
 * mobile users would have no way to reach the sidebar drawer (the desktop
 * rail and Cmd/Ctrl+B shortcut don't apply on touch). Carries the top
 * safe-area inset so it clears the notch under `viewportFit: 'cover'`.
 */
export function ProjectMobileMenuBar() {
  return (
    <div className="flex md:hidden items-center bg-sidebar pl-1.5 h-[calc(38px+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]">
      <MobileSidebarTrigger />
    </div>
  );
}

/**
 * Project shell top strip.
 *
 * Holds session tabs (one per open project session). Clicking a session in
 * the left sidebar opens it as a tab here; navigating between tabs swaps
 * the chat view without unmounting the shell. Close (×) drops the tab and,
 * if it was active, routes back to the project sessions list.
 *
 * macOS-traffic-light spacing + mobile sidebar toggles mirror the legacy
 * dashboard's TabBar so the chrome height/density matches across surfaces.
 */
export function ProjectTabBar({ projectId }: ProjectTabBarProps) {
  const sidebar = useSidebar();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  const tabsByProject = useProjectSessionTabsStore((s) => s.tabsByProject);
  const openTab = useProjectSessionTabsStore((s) => s.openTab);
  const closeTab = useProjectSessionTabsStore((s) => s.closeTab);
  const openCustomizeTab = useProjectSessionTabsStore((s) => s.openCustomizeTab);
  const openTabIds = useMemo(
    () => tabsByProject[projectId] ?? [],
    [tabsByProject, projectId],
  );
  const isCustomizeRoute =
    pathname?.startsWith(`/projects/${projectId}/customize`) ?? false;

  // Auto-open the current session as a tab whenever the URL points at one.
  useEffect(() => {
    if (activeSessionId) openTab(projectId, activeSessionId);
  }, [projectId, activeSessionId, openTab]);

  // Auto-open the Customize tab any time the URL lands on /customize — this
  // covers deep links (e.g. a /files redirect) and back/forward nav.
  useEffect(() => {
    if (isCustomizeRoute) openCustomizeTab(projectId);
  }, [isCustomizeRoute, projectId, openCustomizeTab]);

  // Load session metadata so tabs can show the real title instead of a UUID.
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

  // macOS desktop traffic-light spacing — mirrors tab-bar.tsx.
  const [isMacDesktop, setIsMacDesktop] = useState(false);
  useEffect(() => {
    setIsMacDesktop(isDesktop() && desktopPlatform() === 'macos');
  }, []);
  const needsTrafficLightSpace = isMacDesktop && sidebar.state === 'collapsed';

  const hrefForTab = (id: string) =>
    id === CUSTOMIZE_TAB_ID
      ? `/projects/${projectId}/customize`
      : `/projects/${projectId}/sessions/${id}`;

  const isTabActive = (id: string) =>
    id === CUSTOMIZE_TAB_ID
      ? isCustomizeRoute
      : (pathname?.startsWith(`/projects/${projectId}/sessions/${id}`) ?? false);

  const handleCloseTab = (id: string) => {
    const wasActive = isTabActive(id);
    const remaining = openTabIds.filter((t) => t !== id);
    closeTab(projectId, id);

    if (!wasActive) return;
    if (remaining.length > 0) {
      // Focus the closest neighbor (the tab that took this one's slot).
      const idx = openTabIds.indexOf(id);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      router.push(hrefForTab(next));
    } else {
      // No tabs left → back to the project index (new-session composer).
      router.push(`/projects/${projectId}`);
    }
  };

  return (
    <div
      className="flex-shrink-0 flex items-stretch bg-sidebar h-[calc(38px+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] relative overflow-hidden"
      role="tablist"
    >
      {/* Mobile: open the sidebar drawer. */}
      <div className="flex-shrink-0 flex items-center pl-1.5 pr-1 md:hidden">
        <MobileSidebarTrigger />
      </div>

      {/* Desktop back/forward */}
      <div
        className={cn(
          'flex-shrink-0 items-center gap-0 pr-1 hidden md:flex',
          needsTrafficLightSpace ? 'pl-10' : 'pl-2',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => window.history.back()}
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
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
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Forward
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Tabs — mirrors components/tabs/tab-bar.tsx OG styling: flat row,
          bottom accent line on active, hover-fade close button. Customize is
          just another entry in the ordered list (no longer pinned first), so
          it sits wherever it was opened and closes like any other tab. */}
      <div className="flex-1 flex items-stretch overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {openTabIds.map((tabId) => {
          const isCustomize = tabId === CUSTOMIZE_TAB_ID;
          const isActive = isTabActive(tabId);
          // Sessions don't carry a user-set name yet (API model is branch-only).
          // Fall back to a short id slice until naming ships.
          const label = isCustomize ? 'Customize' : `session ${tabId.slice(0, 8)}`;

          return (
            <div
              key={tabId}
              role="tab"
              aria-selected={isActive}
              onClick={() => router.push(hrefForTab(tabId))}
              className={cn(
                'group relative flex items-center text-sm select-none cursor-pointer',
                'transition-colors duration-150 h-full',
                'gap-1.5 px-2.5 md:gap-2 md:px-3 max-w-[200px] min-w-[96px] md:min-w-[80px]',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {isCustomize && <SlidersHorizontal className="h-3 w-3 flex-shrink-0" />}
              <span className={cn('flex-1 truncate', isActive && 'font-medium')}>{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tabId);
                }}
                className={cn(
                  'flex-shrink-0 p-0.5 rounded-sm transition-colors duration-100 cursor-pointer',
                  'hover:bg-foreground/10',
                  isActive
                    // active tab: tappable close on touch, hover-dimmed on desktop
                    ? 'opacity-60 md:opacity-40 md:hover:opacity-80'
                    // inactive tab: desktop hover only (no hover target on touch)
                    : 'hidden md:block md:opacity-0 md:group-hover:opacity-40 md:group-hover:hover:opacity-80',
                )}
                aria-label={`Close ${label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>

              {/* Active indicator — bottom accent line, same as OG */}
              {isActive && (
                <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-foreground/80 rounded-full" />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-shrink-0 flex items-center pr-2 relative z-20 bg-sidebar pl-1 h-full" />
    </div>
  );
}
