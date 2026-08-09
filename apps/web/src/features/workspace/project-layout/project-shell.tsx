'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect } from 'react';

import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SidebarEdgePeek, useSidebar } from '@/components/ui/sidebar';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { useDesktopShell } from '@/features/workspace/project-layout/sidebar-opener';
import { parseSidebarStateCookie } from '@/features/workspace/project-layout/sidebar-cookie';
import { ProjectSidebar } from '@/features/workspace/project-sidebar/project-sidebar';
import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import { legacySectionRedirect } from '@/features/workspace/settings/settings-tabs';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import {
  clearLastProjectId,
  readLastProjectId,
  writeLastProjectId,
} from '@/lib/onboarding/last-project-cookie';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useGatewayCatalogSync } from '@kortix/sdk/react';
import { SidebarSimpleIcon as PanelLeft } from '@phosphor-icons/react';

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
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
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
    // Old bookmarks/links carry `?customize=<legacy-section-id>`. Files,
    // Connectors, Skills, and Commands graduated out of the overlay into
    // their own pages; every other legacy id resolves through
    // `legacySectionRedirect` to its `/settings/<tab>` route, which itself
    // opens the Settings overlay via the store and bounces back here — see
    // that route's header comment. An unrecognized id just drops the stale
    // query param.
    const raw = searchParams.get('customize');
    if (!raw) return;
    const redirect = legacySectionRedirect(projectId, raw);
    if (redirect) {
      router.replace(redirect);
      return;
    }

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

  // New-session navigation opens the project composer. The first send creates
  // the durable session.
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

        <SettingsPanel projectId={projectId} />

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
  // rail), so a hidden sidebar means no seam border and no way back from the
  // panel itself. On the desktop shell the reopen control lives HERE, in the
  // OS title-bar band; on the web each view draws its own. Shared gate so the
  // two can never both render — see sidebar-opener.ts.
  const desktopShell = useDesktopShell();
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
            // The ONE sidebar opener on the desktop shell — every view-level
            // copy is suppressed by useShowPageSidebarOpener() so this cannot
            // become the second control in the same corner.
            //
            // Placed by the band variables, not by a literal: on macOS the
            // traffic lights are positioned by the Electron main process, so
            // the two numbers live in different processes and used to drift
            // (this box centered at y=26, the lights at y=30). The variables
            // are generated from one table — see globals.css and
            // apps/desktop-electron/src/window-chrome.js. They also carry the
            // Win/Linux values, so there is no platform branch here.
            className="text-muted-foreground hover:text-foreground fixed top-[var(--kx-titlebar-control-top)] left-[var(--kx-titlebar-control-left)] z-50 flex h-[var(--kx-titlebar-control-size)] w-[var(--kx-titlebar-control-size)] shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out [-webkit-app-region:no-drag] [app-region:no-drag] active:scale-[0.96]"
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )}
      {/* On the web there is deliberately no shell-level opener: each view
          draws its own, in its own layout, gated by
          useShowPageSidebarOpener(). Only the desktop shell needs a
          shell-level one, because only there is the corner owned by the OS. */}
      {children}
    </div>
  );
};

export default ProjectSheelLayout;
