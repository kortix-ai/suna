'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { AppsOverlay } from '@/components/projects/apps/apps-overlay';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import Hint from '@/components/ui/hint';
import { useSidebar } from '@/components/ui/sidebar';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { PanelLeft } from 'lucide-react';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { CustomizPanel } from '@/features/workspace/customize/customize-panel';
import { parseSidebarStateCookie } from '@/features/workspace/project-layout/sidebar-cookie';
import { ProjectSidebar } from '@/features/workspace/project-sidebar/project-sidebar';
import { useGatewayCatalogSync } from '@/hooks/opencode/use-gateway-catalog-sync';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { parseCustomizeSection } from '@/lib/customize-sections';
import { getProjectDetail } from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useCustomizeStore } from '@/stores/customize-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

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
  const { state, toggleSidebar } = useSidebar();
  const isExpanded = state === 'expanded';
  // Desktop shell: the sidebar hides fully (offcanvas, no icon rail), so a
  // hidden sidebar means no seam border/nudge, and the reopen control lives
  // up in the title-bar band next to the OS window controls. Client-only
  // tree (ProjectShell gates on auth), so reading the UA at first render is
  // safe.
  const [desktopShell] = useState<'macos' | 'other' | null>(() =>
    isDesktop() ? (desktopPlatform() === 'macos' ? 'macos' : 'other') : null,
  );
  const hideSeam = desktopShell !== null && !isExpanded;
  return (
    <div
      className={cn(
        'bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden',
        !hideSeam && 'border-border border-l-[1.5px]',
        !isExpanded && desktopShell === null && 'ml-0.5',
      )}
    >
      {desktopShell && !isExpanded && (
        <Hint label="Open sidebar" side="bottom">
          <button
            type="button"
            aria-label="Open sidebar"
            onClick={toggleSidebar}
            className={cn(
              // top-[16px] + 28px box centers the button on the traffic
              // lights' midline (y≈30 — pixel-calibrated against real macOS 26
              // window screenshots: Tahoe draws ~14pt lights lower than the
              // classic geometry). px values on purpose: the lights are
              // OS-positioned in window px, while rem sizes drift with the
              // root font size.
              'kx-fade-up hover:bg-accent/60 text-muted-foreground hover:text-foreground fixed top-[12px] z-50 flex h-[28px] w-[28px] [-webkit-app-region:no-drag] cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] [app-region:no-drag]',
              // macOS: sit just past the traffic lights (they end at x≈62),
              // mirroring their own 10px inset. Win/Linux: controls live
              // top-right, so hug the left edge instead.
              desktopShell === 'macos' ? 'left-[4.5rem]' : 'left-2',
            )}
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </button>
        </Hint>
      )}
      {children}
    </div>
  );
};

export default ProjectSheelLayout;
