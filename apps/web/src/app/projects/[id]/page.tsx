'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { ProjectShell } from '@/components/projects/project-shell';
import { ProjectSetupChecklist } from '@/components/projects/project-setup';
import { SessionWelcome } from '@/components/session/session-welcome';
import {
  SessionChatInput,
  type AttachedFile,
} from '@/components/session/session-chat-input';
import {
  createProjectSession,
  type ProjectSession,
} from '@/lib/projects-client';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { toast } from '@/lib/toast';

/**
 * Project root — the new-session empty state.
 *
 * Renders the exact same empty state as a fresh session (SessionWelcome
 * wallpaper full-bleed + the bottom-docked SessionChatInput, no centered
 * title), so it's a typeable composer with working attachments that is
 * visually identical to opening a new session.
 *
 * On send we create the session, stash the message, and route into the session,
 * which auto-sends it once the runtime is ready. Simply opening this page should
 * not create a stealth session.
 */
export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const pendingSession = useRef<Promise<ProjectSession> | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // "Run your first session" step → drop the user straight into the composer
  // that's already docked at the bottom of this very page.
  const focusComposer = useCallback(() => {
    rootRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);

  const createSession = useCallback(() => {
    if (!pendingSession.current) {
      pendingSession.current = createProjectSession(projectId)
        .then((s) => {
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
          return s;
        })
        .catch((err) => {
          pendingSession.current = null; // allow a retry on the next attempt
          throw err;
        });
    }
    return pendingSession.current;
  }, [projectId, queryClient]);

  const handleSend = useCallback(
    async (text: string, files?: AttachedFile[]) => {
      if (!text.trim() && !files?.length) return;
      setBusy(true);
      try {
        const session = await createSession();
        // The session view's pending-prompt handoff (ActiveSessionChat) reads
        // this; files ride along via the global pending-files store.
        sessionStorage.setItem(`project_pending_prompt:${session.session_id}`, text);
        if (files?.length) usePendingFilesStore.getState().setPendingFiles(files);
        router.push(`/projects/${projectId}/sessions/${session.session_id}`);
      } catch (err) {
        setBusy(false);
        toast.error(err instanceof Error ? err.message : 'Failed to start session');
      }
    },
    [createSession, projectId, router],
  );

  return (
    <ProjectShell projectId={projectId}>
      <div
        ref={rootRef}
        className="relative flex-1 min-h-0 flex flex-col overflow-hidden bg-background"
      >
        {/* Full-bleed welcome wallpaper — identical to a real empty session */}
        <div className="absolute inset-0 z-0 pointer-events-none">
          <SessionWelcome />
        </div>

        {/* Setup checklist (hidden once the project is configured) floats over
            the wallpaper; the region still pushes the composer to the bottom. */}
        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
          <ProjectSetupChecklist projectId={projectId} onStartSession={focusComposer} />
        </div>

        {/* The real (typeable) chat input, docked at the bottom */}
        <SessionChatInput onSend={handleSend} disabled={busy} autoFocus />
      </div>
    </ProjectShell>
  );
}
