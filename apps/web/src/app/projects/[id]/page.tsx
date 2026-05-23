'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { ProjectShell } from '@/components/projects/project-shell';
import { SessionWelcome } from '@/components/session/session-welcome';
import {
  SessionChatInput,
  type AttachedFile,
} from '@/components/session/session-chat-input';
import {
  createProjectSession,
  deleteProjectSession,
  type ProjectSession,
} from '@/lib/projects-client';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { toast } from '@/lib/toast';

/**
 * Project root — the new-session empty state.
 *
 * Reuses the real session empty state (SessionWelcome wallpaper +
 * SessionChatInput), so it's a typeable composer with working attachments —
 * visually near-identical to a fresh session.
 *
 * Warm start: the moment the user engages the input (focus / first keystroke)
 * we provision the session + sandbox in the background, so by the time they
 * press Enter the work has a head start. On send we stash the message and route
 * into the session, which auto-sends it once the runtime is ready (the session
 * view shows its own loader while the sandbox boots). If the user leaves
 * without sending, the warm session is deleted so we never orphan a sandbox.
 */
export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const warm = useRef<{ promise: Promise<ProjectSession> | null; sent: boolean }>({
    promise: null,
    sent: false,
  });
  const [busy, setBusy] = useState(false);

  const ensureSession = useCallback(() => {
    if (!warm.current.promise) {
      warm.current.promise = createProjectSession(projectId)
        .then((s) => {
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
          return s;
        })
        .catch((err) => {
          warm.current.promise = null; // allow a retry on the next attempt
          throw err;
        });
    }
    return warm.current.promise;
  }, [projectId, queryClient]);

  // Begin provisioning as soon as the user engages the input.
  const warmStart = useCallback(() => {
    if (!warm.current.promise) void ensureSession().catch(() => {});
  }, [ensureSession]);

  const handleSend = useCallback(
    async (text: string, files?: AttachedFile[]) => {
      if (!text.trim() && !files?.length) return;
      setBusy(true);
      try {
        const session = await ensureSession();
        warm.current.sent = true;
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
    [ensureSession, projectId, router],
  );

  // Delete a warm-started-but-unsent session when leaving the index.
  useEffect(() => {
    return () => {
      const { promise, sent } = warm.current;
      if (promise && !sent) {
        void promise
          .then((s) => deleteProjectSession(projectId, s.session_id))
          .catch(() => {});
      }
    };
  }, [projectId]);

  return (
    <ProjectShell projectId={projectId}>
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
        {/* Same full-bleed wallpaper as a real empty session */}
        <div className="absolute inset-0 z-0 pointer-events-none">
          <SessionWelcome />
        </div>

        {/* Centered title + the real (typeable) chat input */}
        <div
          className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center gap-6 px-4"
          onFocusCapture={warmStart}
          onInput={warmStart}
        >
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              What should we build?
            </h1>
            <p className="text-sm text-muted-foreground">
              Describe a task to start a new session in this project.
            </p>
          </div>
          <SessionChatInput onSend={handleSend} disabled={busy} autoFocus />
        </div>
      </div>
    </ProjectShell>
  );
}
