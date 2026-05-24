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
 * Renders the exact same empty state as a fresh session (SessionWelcome
 * wallpaper full-bleed + the bottom-docked SessionChatInput, no centered
 * title), so it's a typeable composer with working attachments that is
 * visually identical to opening a new session.
 *
 * Warm start: we provision the session + sandbox the moment the page loads, so
 * by the time the user presses Enter the work has a head start. On send we stash
 * the message and route into the session, which auto-sends it once the runtime
 * is ready (the session view shows its own loader while the sandbox boots). If
 * the user leaves without sending, the warm session is deleted so we never
 * orphan a sandbox.
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

  // Begin provisioning the session + sandbox (focus/keystroke also call this).
  const warmStart = useCallback(() => {
    if (!warm.current.promise) void ensureSession().catch(() => {});
  }, [ensureSession]);

  // Auto-provision the moment the page loads — don't wait for the user to
  // engage the input — so the sandbox is already booting by the time they
  // type. If they leave without sending, the cleanup below deletes it.
  useEffect(() => {
    warmStart();
  }, [warmStart]);

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

  // Delete a warm-started-but-unsent session when leaving the index (or when
  // switching projects), and reset the ref so the next project provisions fresh.
  useEffect(() => {
    return () => {
      const { promise, sent } = warm.current;
      if (promise && !sent) {
        void promise
          .then((s) => deleteProjectSession(projectId, s.session_id))
          .catch(() => {});
      }
      warm.current = { promise: null, sent: false };
    };
  }, [projectId]);

  return (
    <ProjectShell projectId={projectId}>
      <div
        className="relative flex-1 min-h-0 flex flex-col overflow-hidden bg-background"
        onFocusCapture={warmStart}
        onInput={warmStart}
      >
        {/* Full-bleed welcome wallpaper — identical to a real empty session */}
        <div className="absolute inset-0 z-0 pointer-events-none">
          <SessionWelcome />
        </div>

        {/* Empty transparent region pushes the composer to the bottom, just
            like a fresh session — wallpaper reads through, no centered title. */}
        <div className="relative flex-1 min-h-0 z-10" />

        {/* The real (typeable) chat input, docked at the bottom */}
        <SessionChatInput onSend={handleSend} disabled={busy} autoFocus />
      </div>
    </ProjectShell>
  );
}
