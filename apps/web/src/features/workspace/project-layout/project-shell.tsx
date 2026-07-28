'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SidebarEdgePeek, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { CustomizPanel } from '@/features/workspace/customize/customize-panel';
import { ProjectPrefetcher } from '@/features/workspace/project-layout/project-prefetcher';
import { ShellInset } from '@/features/workspace/project-layout/shell-inset';
import { parseSidebarStateCookie } from '@/features/workspace/project-layout/sidebar-cookie';
import { ProjectSidebar } from '@/features/workspace/project-sidebar/project-sidebar';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { desktopShellPlatform } from '@/lib/desktop';
import { resolveLegacyCustomizeHref } from '@/lib/project-nav';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useLastProjectStore } from '@/stores/last-project-store';
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

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });

  useGatewayCatalogSync(projectId);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Record where the user is working so `/` can bring them straight back.
  // This runs inside ProjectAccessBoundary, so a 403 project is never stored.
  const landingAccountId = projectDetail?.project?.account_id ?? null;
  useEffect(() => {
    if (!user || !projectId) return;
    useLastProjectStore.getState().setLastProject(landingAccountId, projectId);
  }, [user, projectId, landingAccountId]);

  useEffect(() => {
    // Legacy `?customize=<section>` deep links now resolve to a real route
    // (lib/project-nav is exhaustive over all 24 sections, and over the
    // files/changes redirects) instead of opening the overlay in place.
    const raw = searchParams.get('customize');
    if (!raw) return;
    const href = resolveLegacyCustomizeHref(projectId, raw);
    if (href) {
      router.replace(href);
      return;
    }
    // Unknown value: strip it rather than leaving a dead param in the URL.
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

          {/* Warms Files, Automations, Secrets and project detail so those
              screens open from cache instead of a cold waterfall. */}
          <ProjectPrefetcher projectId={projectId} />

          <ShellInset>{children}</ShellInset>
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
