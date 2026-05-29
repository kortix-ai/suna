'use client';

import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { ProjectShell } from '@/components/projects/project-shell';
import { ProjectHome, type ProjectHomeSendOptions } from '@/components/projects/project-home';
import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';

/**
 * Project root — the project home / dashboard.
 *
 * A welcome hero + a composer to start a session, over a grid of section tiles
 * (integrations, scheduled tasks, skills, Slack, team, agent) that tease the
 * feature and prompt setup, each docs-backed.
 *
 * Send flow is **optimistic**: we mint the session id client-side, navigate
 * straight into the ConnectingScreen, then POST in the background. That
 * removes the entire session-create round-trip from perceived boot time.
 * The session id is a real UUID; the API accepts client-provided ids via the
 * `session_id` body field (see apps/api/src/projects/index.ts createProjectSession).
 */
export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);

  const handleSend = useCallback(
    (text: string, options?: ProjectHomeSendOptions) => {
      if (!text.trim()) return;
      setBusy(true);

      // 1. Generate the session id locally — same RFC 4122 v4 shape the API
      //    would have generated. We stash the pending prompt under this id
      //    *before* navigating so ActiveSessionChat picks it up the moment
      //    the page mounts.
      const sessionId = crypto.randomUUID();
      sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);

      // 2. Navigate FIRST — the ConnectingScreen renders against an empty
      //    sandbox row and starts polling. From the user's perspective the
      //    click is instant.
      router.push(`/projects/${projectId}/sessions/${sessionId}`);

      // 3. POST in the background. Errors get a toast but we leave the
      //    navigation in place; ActiveSessionChat will surface the failure
      //    once the sandbox poll returns 404.
      void createProjectSession(projectId, {
        session_id: sessionId,
        ...(options?.sandbox_slug ? { sandbox_slug: options.sandbox_slug } : {}),
      })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        })
        .catch((err) => {
          setBusy(false);
          // 429 concurrent-session-limit is handled globally — skip the local toast.
          if ((err as any)?.code === 'concurrent_session_limit') return;
          toast.error(err instanceof Error ? err.message : 'Failed to start session');
        });
    },
    [projectId, queryClient, router],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={busy} />
    </ProjectShell>
  );
}
