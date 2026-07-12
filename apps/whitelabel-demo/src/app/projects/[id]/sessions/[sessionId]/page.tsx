'use client';

import { ProjectShell } from '@/components/project-shell';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { WorkbenchTabs } from '@/components/workbench/workbench-tabs';
import { useSession } from '@kortix/sdk/react';
import { useParams } from 'next/navigation';

export default function SessionWorkbenchPage() {
  return (
    <ProjectShell>
      <Workbench />
    </ProjectShell>
  );
}

function Workbench() {
  const params = useParams();
  const projectId = String(params.id);
  const sessionId = String(params.sessionId);

  // ONE hook owns the entire runtime: /start (server long-poll), the sandbox
  // switch, the live SSE stream, the canonical OpenCode id, and message sync.
  // The host never imports server-store, a health poller, or an event provider —
  // it reads `session.phase` and renders. That's the whole contract.
  const session = useSession(projectId, sessionId);

  return (
    <>
      <SessionHeader
        projectId={projectId}
        sessionId={sessionId}
        messages={session.phase === 'ready' ? session.messages : undefined}
      />
      {session.phase !== 'ready' ? (
        <BootScreen
          stage={session.stage ?? undefined}
          reason={session.reason ?? undefined}
          failed={session.isError}
          onRetry={session.retry}
        />
      ) : (
        <WorkbenchTabs session={session} projectId={projectId} sessionId={sessionId} />
      )}
    </>
  );
}
