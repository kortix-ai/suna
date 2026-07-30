'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SidebarEdgePeek, useSidebar } from '@/components/ui/sidebar';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { CustomizPanel } from '@/features/workspace/customize/customize-panel';
import { parseSidebarStateCookie } from '@/features/workspace/project-layout/sidebar-cookie';
import { ProjectSidebar } from '@/features/workspace/project-sidebar/project-sidebar';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { parseCustomizeSection } from '@/lib/customize-sections';
import { desktopShellPlatform } from '@/lib/desktop';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import {
  clearLastProjectId,
  readLastProjectId,
  writeLastProjectId,
} from '@/lib/onboarding/last-project-cookie';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useCustomizeStore } from '@/stores/customize-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { getProjectDetail } from '@kortix/sdk';
import { useGatewayCatalogSync } from '@kortix/sdk/react';
import { PanelLeft } from 'lucide-react';

const CommandPalette = lazy(() =>
  import('@/features/workspace/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

const PresentationViewerWrapper = lazy(() =>
  import('@/stores/presentation-viewer-store').then((mod) => ({
    default: mod.PresentationViewerWrapper,
  })),
);

interface ProjectShellProps {
  projectId: string;
  initialSidebarOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Read the sidebar's persisted open/collapsed state from the `sidebar_state`
 * cookie that {@link SidebarProvider} writes on every toggle. Client-only —
 * the shell is gated behind client auth, so the provider never renders during
 * SSR and this cannot cause a hydration mismatch.
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

  const { data: projectDetail, error: projectDetailError } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });

  useGatewayCatalogSync(projectId);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Remember the project so the next `/` hit and the next sign-in land straight
  // back here instead of going through the id-free landing door. Gated on a
  // successful detail fetch: recording a project the user cannot actually read
  // would send them into a 404 bounce loop on their next visit.
  useEffect(() => {
    if (!projectDetail) return;
    writeLastProjectId(user?.id, projectId);
  }, [projectDetail, projectId, user?.id]);

  // Self-heal a stale remembered project. The cookie outlives the project it
  // names (deleted project, signed into a different account on the same
  // browser), and it drives the `/` and post-auth redirects — so left alone it
  // would send the user to an unreadable project on every single visit. Drop it
  // and re-resolve through the landing door.
  useEffect(() => {
    if (!projectDetailError) return;
    const status = (projectDetailError as { status?: number }).status;
    if (status !== 403 && status !== 404) return;
    if (readLastProjectId(user?.id) !== projectId) return;
    clearLastProjectId();
    router.replace(PROJECT_LANDING_PATH);
  }, [projectDetailError, projectId, router, user?.id]);

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
    // `resolved` is what keeps the sidebar's billing items from flickering:
    // until project-detail lands we don't know this project's account, and a
    // provisional fetch against the primary account would paint them once,
    // then unpaint them when the real account id swaps the cache slot.
    <BillingAccountProvider
      accountId={projectDetail?.project?.account_id ?? null}
      resolved={!!projectDetail}
    >
      <AppProviders
        showSidebar
        showRightSidebar={false}
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

        <Suspense fallback={null}>
          <PresentationViewerWrapper />
        </Suspense>

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
        isExpanded && 'border-border border-l',
      )}
    >
      {/* Collapsed: an invisible strip on the viewport's left edge summons
          the sidebar as a hover flyout; it self-hides while docked open. */}
      <SidebarEdgePeek />
      {/* Mobile: the sidebar is a sheet with no docked affordance, and view
          headers come and go (sessions render theirs only once booted) — so
          the opener lives here, always mounted, on every project view. The
          session header indents its leading buttons past it below md. */}

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
              'text-muted-foreground hover:text-foreground fixed top-[12px] z-50 flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out [-webkit-app-region:no-drag] [app-region:no-drag] active:scale-[0.96]',
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
      {/* {!desktopShell && !isExpanded && (
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
            className="text-muted-foreground hover:text-foreground absolute top-2 left-2 z-30 hidden shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] md:flex"
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )} */}
      {children}
    </div>
  );
};

export default ProjectSheelLayout;
