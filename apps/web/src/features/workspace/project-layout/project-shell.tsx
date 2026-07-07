'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { AppsOverlay } from '@/components/projects/apps/apps-overlay';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SidebarEdgePeek, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { CustomizPanel } from '@/features/workspace/customize/customize-panel';
import { parseSidebarStateCookie } from '@/features/workspace/project-layout/sidebar-cookie';
import { ProjectSidebar } from '@/features/workspace/project-sidebar/project-sidebar';
import { useGatewayCatalogSync } from '@/hooks/opencode/use-gateway-catalog-sync';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { parseCustomizeSection } from '@/lib/customize-sections';
import { desktopShellPlatform } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useCustomizeStore } from '@/stores/customize-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { getProjectDetail } from '@kortix/sdk/projects-client';
import { PanelLeft } from 'lucide-react';

const CommandPalette = lazy(() =>
  import('@/features/workspace/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

interface ProjectShellProps {
  projectId: string;
  initialSidebarOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Read the sidebar's persisted open/collapsed state from the `sidebar_state`
 * cookie that {@link SidebarProvider} writes on every toggle. ProjectShell
 * remounts on navigation (opening a session, ⌘J, switching sessions), so
 * without re-seeding from the cookie the sidebar snaps back to its default
 * (expanded) every time. Client-only — the shell is gated behind client auth,
 * so the provider never renders during SSR and this can't cause a hydration
 * mismatch.
 */
function readSidebarOpenCookie(): boolean | undefined {
  if (typeof document === 'undefined') return undefined;
  return parseSidebarStateCookie(document.cookie);
}

export function ProjectShell({ projectId, initialSidebarOpen, children }: ProjectShellProps) {
  const resolvedSidebarOpen = initialSidebarOpen ?? readSidebarOpenCookie();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading: authLoading } = useAuth();

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });

  useGatewayCatalogSync(projectId);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  useEffect(() => {
    // Files graduated out of Customize into its own page — send legacy
    // ?customize=files links there instead of opening the overlay.
    if (searchParams.get('customize') === 'files') {
      router.replace(`/projects/${projectId}/files`);
      return;
    }
    const section = parseCustomizeSection(searchParams.get('customize'));
    if (!section) return;
    useCustomizeStore.getState().openCustomize(section);

    const next = new URLSearchParams(searchParams.toString());
    next.delete('customize');
    const query = next.toString();
    router.replace(`/projects/${projectId}${query ? `?${query}` : ''}`, { scroll: false });
  }, [projectId, router, searchParams]);

  useEffect(() => {
    try {
      const backend = (process.env.NEXT_PUBLIC_BACKEND_URL || window.location.origin).replace(
        /\/v1\/?$/,
        '',
      );
      const origin = new URL(backend).origin;
      const existing = document.querySelector(`link[rel="preconnect"][href="${origin}"]`);
      if (existing) return;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = '';
      document.head.appendChild(link);
      return () => {
        link.remove();
      };
    } catch {
      /* preconnect is best-effort */
    }
  }, []);

  // Optimistic new-session: mint the id client-side and navigate immediately so
  // the instant shell paints before the create POST returns (see
  // useNewProjectSession). Shared with the sidebar / ⌘T-⌘J / command palette.
  const newSession = useNewProjectSession(projectId);
  const handleNewSession = useCallback(() => {
    newSession();
  }, [newSession]);

  useProjectShellShortcuts({ projectId, onNewSession: handleNewSession });

  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  const openTab = useProjectSessionTabsStore((s) => s.openTab);

  useLayoutEffect(() => {
    if (activeSessionId) openTab(projectId, activeSessionId);
  }, [projectId, activeSessionId, openTab]);

  if (authLoading || !user) {
    return <div className="bg-background min-h-screen" />;
  }

  return (
    <BillingAccountProvider accountId={projectDetail?.project?.account_id ?? null}>
      <AppProviders
        showSidebar
        showRightSidebar={false}
        showGlobalNewInstanceModal={false}
        showGlobalUserSettingsModal={false}
        defaultSidebarOpen={resolvedSidebarOpen}
        sidebarContent={<ProjectSidebar projectId={projectId} />}
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>

          <ProjectSheelLayout>{children}</ProjectSheelLayout>
        </div>

        <CustomizPanel projectId={projectId} />

        <AppsOverlay projectId={projectId} />

        <ProjectOnboardingWizard projectId={projectId} />

        <PersonalOnboardingWelcome projectId={projectId} />
      </AppProviders>
    </BillingAccountProvider>
  );
}

const ProjectSheelLayout = ({ children }: { children: React.ReactNode }) => {
  const { state, toggleSidebar, peek, peekEnter, peekLeave } = useSidebar();
  const isExpanded = state === 'expanded';
  // The sidebar hides fully when collapsed (offcanvas everywhere, no icon
  // rail), so a hidden sidebar means no seam border. The reopen control lives
  // in the title-bar band next to the OS window controls on the desktop
  // shell, and in a top-left cluster aligned with the session site header on
  // the web. Client-only tree (ProjectShell gates on auth), so reading the UA
  // at first render is safe.
  const [desktopShell] = useState(() => desktopShellPlatform());
  return (
    <div
      className={cn(
        'bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden',
        isExpanded && 'border-border border-l-[1.5px]',
      )}
    >
      {/* Collapsed: an invisible strip on the viewport's left edge summons
          the sidebar as a hover flyout; it self-hides while docked open. */}
      <SidebarEdgePeek />
      {/* Mobile: the sidebar is a sheet with no docked affordance, and view
          headers come and go (sessions render theirs only once booted) — so
          the opener lives here, always mounted, on every project view. The
          session header indents its leading buttons past it below md. */}
      <SidebarTrigger
        aria-label="Open sidebar"
        className="text-muted-foreground hover:text-foreground absolute top-2 left-2 z-30 size-8 md:hidden"
      />
      {desktopShell && !isExpanded && (
        <Hint label={peek ? 'Pin sidebar' : 'Open sidebar'} side="bottom">
          <Button
            type="button"
            aria-label={peek ? 'Pin sidebar' : 'Open sidebar'}
            onClick={toggleSidebar}
            onPointerEnter={peekEnter}
            onPointerLeave={peekLeave}
            variant="ghost"
            className={cn(
              // top-[12px] + 28px box centers the button on the traffic
              // lights' midline (y=26 — the app draws its own lights there;
              // see DesktopChrome → MacTrafficLights). px values on purpose:
              // the lights are positioned in window px, while rem sizes
              // drift with the root font size.
              'kx-fade-up text-muted-foreground hover:text-foreground fixed top-[12px] z-50 flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out [-webkit-app-region:no-drag] [app-region:no-drag] active:scale-[0.96]',
              // macOS: sit just past the traffic lights (they end at x≈62),
              // mirroring their own 10px inset. Win/Linux: controls live
              // top-right, so hug the left edge instead.
              desktopShell === 'macos' ? 'left-[4.5rem]' : 'left-2',
            )}
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )}
      {!desktopShell && !isExpanded && (
        // Same row as the session site header's leading cluster (p-2 +
        // size-8 buttons), so the toggle reads as part of it. Hovering it
        // also summons the flyout, mirroring the edge strip.
        <Hint label={peek ? 'Pin sidebar' : 'Open sidebar'} side="bottom">
          <Button
            type="button"
            aria-label={peek ? 'Pin sidebar' : 'Open sidebar'}
            onClick={toggleSidebar}
            onPointerEnter={peekEnter}
            onPointerLeave={peekLeave}
            variant="ghost"
            size="icon"
            className="kx-fade-up text-muted-foreground hover:text-foreground absolute top-2 left-2 z-30 hidden shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] md:flex"
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )}
      {children}
    </div>
  );
};

export default ProjectSheelLayout;
