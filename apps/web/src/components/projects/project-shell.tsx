'use client';

import { Suspense, lazy, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/components/AuthProvider';
import { AppProviders } from '@/components/layout/app-providers';
import { ProjectSidebar } from '@/components/projects/project-sidebar';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { useIsSwitchingProject } from '@/stores/project-switch-store';

// CommandPalette is mounted here (not in AppProviders) so it loads lazily and
// owns the global Cmd+K / Cmd+` listeners while a project shell is on screen.
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

/**
 * Project shell — repo-first chrome for `/projects/*`.
 * It reuses the shared sidebar frame but disables legacy dashboard globals
 * like the old instance modal and dashboard command palette.
 */
export function ProjectShell({
  projectId,
  initialSidebarOpen,
  children,
}: ProjectShellProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Single canonical "new session" path used by both the sidebar button and
  // the Mod+T / Mod+J keyboard shortcuts. Lifted here so it lives above the
  // shortcut hook (which only sees the shell, not the sidebar).
  const createSession = useMutation({
    mutationFn: () => createProjectSession(projectId),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start session');
    },
  });
  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
    createSession.mutate();
  }, [createSession]);

  useProjectShellShortcuts({ projectId, onNewSession: handleNewSession });

  const isSwitchingProject = useIsSwitchingProject();

  // Quiet, chrome-free render until auth resolves — no Kortix logo flash,
  // no progress bar. If unauthenticated, the effect above redirects to /auth.
  if (authLoading || !user) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <AppProviders
      showSidebar
      showRightSidebar={false}
      showGlobalNewInstanceModal={false}
      showGlobalUserSettingsModal={false}
      defaultSidebarOpen={initialSidebarOpen}
      sidebarContent={<ProjectSidebar projectId={projectId} />}
    >
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>

        {/* Top progress hairline — shown while a project switch is in
            flight. Pinned over both the tab bar and the rounded content,
            so it reads as "the whole shell is loading", not just one panel. */}
        <AnimatePresence>
          {isSwitchingProject && (
            <motion.div
              key="project-switch-progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute top-0 left-0 right-0 z-50 pointer-events-none h-[2px] bg-foreground/[0.04] overflow-hidden"
            >
              <div className="h-full w-1/3 bg-foreground/60 animate-connect-progress" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
          {/* Session-internal layout (chat + actions/browser side panel) is
              owned by `apps/web/src/components/session/session-layout.tsx`.
              The project shell just hosts the chrome. */}
          {children}
        </div>
      </div>
    </AppProviders>
  );
}
