'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { ProjectShell } from '@/components/projects/project-shell';
import { ProjectHome } from '@/components/projects/project-home';
import {
  createProjectSession,
  type ProjectSession,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';

/**
 * Project root — the project home / dashboard.
 *
 * A welcome hero + a composer to start a session, over a grid of section tiles
 * (integrations, scheduled tasks, skills, Slack, team, agent) that tease the
 * feature and prompt setup, each docs-backed.
 *
 * Opening this page does not create a stealth session: a session is created on
 * send, then we route into it (the session view auto-sends the stashed prompt
 * once the runtime is ready).
 */
export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const pendingSession = useRef<Promise<ProjectSession> | null>(null);
  const [busy, setBusy] = useState(false);

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
    async (text: string) => {
      if (!text.trim()) return;
      setBusy(true);
      try {
        const session = await createSession();
        // ActiveSessionChat reads this and auto-sends once the sandbox is ready.
        sessionStorage.setItem(`project_pending_prompt:${session.session_id}`, text);
        router.push(`/projects/${projectId}/sessions/${session.session_id}`);
      } catch (err) {
        setBusy(false);
        // 429 concurrent-session-limit is handled globally in error-handler.ts —
        // skip the local toast to avoid showing two stacked messages.
        if ((err as any)?.code === 'concurrent_session_limit') return;
        toast.error(err instanceof Error ? err.message : 'Failed to start session');
      }
    },
    [createSession, projectId, router],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={busy} />
    </ProjectShell>
  );
}
