'use client';

import { ProjectShell } from '@/components/project-shell';
import { SessionApprovals } from '@/components/workbench/approvals-panel';
import { BootScreen } from '@/components/workbench/boot-screen';
import { useRuntimeRecovery } from '@/components/workbench/use-runtime-recovery';
import { useSession } from '@kortix/sdk/react';
import { SessionWorkspace } from '@kortix/ui/workspace';
import { useParams } from 'next/navigation';

export default function SessionWorkbenchPage() {
  return (
    <ProjectShell pageHasSidebarOpener>
      <Workbench />
    </ProjectShell>
  );
}

/**
 * The session screen is Kortix's own: `SessionWorkspace` renders the thread
 * (header, transcript, tool rows, prompts, composer with the model and agent
 * pickers) and the resizable side panel its actions open (files, the viewer,
 * the browser, the terminal, changes). Lumen adds two things around it: the
 * approval gates the agent is blocked on, and the one-shot reconnect when a
 * connected runtime drops.
 */
function Workbench() {
  const params = useParams();
  const projectId = String(params.id);
  const sessionId = String(params.sessionId);

  // One hook owns readiness, transport, streaming, the transcript, prompts and
  // message sync. Everything below reads it.
  const session = useSession(projectId, sessionId);
  useRuntimeRecovery(session);

  return (
    <>
      {/* A `require_approval` gate ends the agent's turn and the transcript
          does not say so. Shown only while one is pending. */}
      <SessionApprovals projectId={projectId} sessionId={sessionId} />
      {session.isError ? (
        <BootScreen
          stage={session.stage ?? undefined}
          reason={session.reason ?? undefined}
          failed
          onRetry={session.retry}
        />
      ) : (
        <SessionWorkspace session={session} className="min-h-0 flex-1" />
      )}
    </>
  );
}
