'use client';

import { Suspense, lazy, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/components/AuthProvider';
import { AppProviders } from '@/components/layout/app-providers';
import { AppsOverlay } from '@/components/projects/apps/apps-overlay';
import { CustomizeOverlay } from '@/components/projects/customize/customize-overlay';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { ProjectSidebar } from '@/components/projects/project-sidebar';
import { ProjectMobileMenuBar, ProjectTabBar } from '@/components/projects/project-tab-bar';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useIsSwitchingProject } from '@/stores/project-switch-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

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

  // Pre-warm DNS + TLS to the sandbox proxy domain the moment the project
  // shell mounts. The first `/global/health` probe after a session boot
  // would otherwise pay a full handshake (~100-400ms on a cold connection);
  // we inject a `<link rel="preconnect">` so the browser establishes the
  // connection in the background while the user is reading the home page.
  useEffect(() => {
    try {
      const backend = (process.env.NEXT_PUBLIC_BACKEND_URL || window.location.origin).replace(/\/v1\/?$/, '');
      const origin = new URL(backend).origin;
      const existing = document.querySelector(`link[rel="preconnect"][href="${origin}"]`);
      if (existing) return;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = '';
      document.head.appendChild(link);
      return () => { link.remove(); };
    } catch { /* preconnect is best-effort */ }
  }, []);

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
      if ((err as any)?.code === 'concurrent_session_limit') return;
      toast.error(err instanceof Error ? err.message : 'Failed to start session');
    },
  });
  const handleNewSession = useCallback(() => {
    if (createSession.isPending) return;
    createSession.mutate();
  }, [createSession]);

  useProjectShellShortcuts({ projectId, onNewSession: handleNewSession });

  const isSwitchingProject = useIsSwitchingProject();
  const disableTabSelector = useUserPreferencesStore((s) => s.preferences.disableTabSelector ?? false);

  // Quiet, chrome-free render until auth resolves — no Kortix logo flash,
  // no progress bar. If unauthenticated, the effect above redirects to /auth.
  if (authLoading || !user) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <AppProviders
      showSidebar
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

        {/* Project tab bar. When tabs are disabled we still leave a small
            sidebar-colored strip so the
            rounded panel "floats" instead of bleeding to the top edge. */}
        <AnimatePresence initial={false}>
          {!disableTabSelector && (
            <motion.div
              key="project-tab-bar"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <ProjectTabBar projectId={projectId} />
            </motion.div>
          )}
        </AnimatePresence>
        {disableTabSelector && (
          <>
            {/* Mobile keeps a slim bar (with the menu button + notch inset) so
                the sidebar drawer stays reachable even with tabs disabled.
                Desktop shows the thin floating strip so the rounded panel
                doesn't bleed to the top edge. */}
            <ProjectMobileMenuBar />
            <div className="hidden md:block flex-shrink-0 bg-sidebar h-3" />
          </>
        )}

        <div
          className={cn(
            // White panel fill so every state (error, loading, active chat)
            // reads as the content card — not the gray sidebar showing through.
            'flex-1 min-h-0 flex flex-col overflow-hidden relative bg-background',
            // Floats off the top (strip above) and the right (sidebar-colored
            // gap), but stays anchored to the bottom edge — no bottom border,
            // bottom corners square. Left stays flush with the sidebar rail.
            'md:border md:border-b-0 md:border-border/50 md:rounded-t-xl md:mr-3',
          )}
        >
          {/* Session-internal layout (chat + actions/browser side panel) is
              owned by `apps/web/src/components/session/session-layout.tsx`.
              The project shell just hosts the chrome. */}
          {children}
        </div>
      </div>

      {/* Customize — a full-screen overlay floating over the active page, so
          opening config never swaps the content area or spawns a tab. */}
      <CustomizeOverlay projectId={projectId} />

      {/* Apps — sibling overlay for the experimental [[apps]] deploy surface.
          Self-gates on the per-project apps toggle (the store only opens when
          the sidebar's gated Apps button fires), so mounting it here is inert
          when apps is disabled for the project. */}
      <AppsOverlay projectId={projectId} />

      {/* Guided onboarding wizard — auto-opens for new projects, fades out
          when customize is on top, dismissed forever once user clicks Skip. */}
      <ProjectOnboardingWizard projectId={projectId} />

      {/* CEO-concierge welcome — dismissible floating widget; localStorage
          dismiss is global so it never re-appears once closed. Hides while
          this project's onboarding wizard is still pending so the user only
          sees one CTA at a time. */}
      <PersonalOnboardingWelcome projectId={projectId} />
    </AppProviders>
  );
}
