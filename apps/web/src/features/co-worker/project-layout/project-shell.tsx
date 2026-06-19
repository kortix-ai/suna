'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';

import { AppsOverlay } from '@/components/projects/apps/apps-overlay';
import { CustomizeOverlay } from '@/components/projects/customize/customize-overlay';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { errorToast } from '@/components/ui/toast';
import { ProjectTabBar } from '@/features/co-worker/project-header/project-tab-bar';
import { ProjectSidebar } from '@/features/co-worker/project-sidebar/project-sidebar';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import {
  createProjectSession,
  getProjectDetail,
  prefetchSessionStart,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { useIsSwitchingProject } from '@/stores/project-switch-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

const CommandPalette = lazy(() =>
  import('@/components/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

interface ProjectShellProps {
  projectId: string;
  initialSidebarOpen?: boolean;
  children: React.ReactNode;
}

export function ProjectShell({ projectId, initialSidebarOpen, children }: ProjectShellProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

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

  const createSession = useMutation({
    mutationFn: () => createProjectSession(projectId),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      prefetchSessionStart(queryClient, projectId, session.session_id);
      router.prefetch(`/projects/${projectId}/sessions/${session.session_id}`);
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
    },
    onError: (err) => {
      if ((err as any)?.code === 'concurrent_session_limit') return;
      errorToast(err instanceof Error ? err.message : 'Failed to start session');
    },
  });
  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
    createSession.mutate();
  }, [createSession]);

  useProjectShellShortcuts({ projectId, onNewSession: handleNewSession });

  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  const tabsByProject = useProjectSessionTabsStore((s) => s.tabsByProject);
  const openTab = useProjectSessionTabsStore((s) => s.openTab);
  const openTabIds = useMemo(() => tabsByProject[projectId] ?? [], [tabsByProject, projectId]);
  const disableTabSelector = useUserPreferencesStore(
    (s) => s.preferences.disableTabSelector ?? false,
  );

  useLayoutEffect(() => {
    if (activeSessionId) openTab(projectId, activeSessionId);
  }, [projectId, activeSessionId, openTab]);

  const showProjectHeader = openTabIds.length > 0 || activeSessionId !== null;
  const isSwitchingProject = useIsSwitchingProject();

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
        defaultSidebarOpen={initialSidebarOpen}
        sidebarContent={<ProjectSidebar projectId={projectId} />}
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>

          <AnimatePresence initial={false}>
            {showProjectHeader ? (
              <motion.div
                key="project-tab-bar"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <ProjectTabBar projectId={projectId} hideTabSelector={disableTabSelector} />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div
            className={cn(
              'bg-background border-border relative flex min-h-0 flex-1 flex-col overflow-hidden border-l-[1.5px]',
              showProjectHeader
                ? 'rounded-t-xl border-t-[1.5px] lg:rounded-tl-lg lg:rounded-tr-none'
                : '',
            )}
          >
            {children}
          </div>
        </div>

        <CustomizeOverlay projectId={projectId} />

        <AppsOverlay projectId={projectId} />

        <ProjectOnboardingWizard projectId={projectId} />

        <PersonalOnboardingWelcome projectId={projectId} />
      </AppProviders>
    </BillingAccountProvider>
  );
}
