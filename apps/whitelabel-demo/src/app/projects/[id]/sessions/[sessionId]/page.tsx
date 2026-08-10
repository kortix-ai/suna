'use client';

import { ProjectShell } from '@/components/project-shell';
import { ApplicationUserBadge } from '@/components/project-access-panel';
import { SessionApprovals } from '@/components/workbench/approvals-panel';
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
  const workspaceId = String(params.id);
  const sessionId = String(params.sessionId);

  // One hook owns readiness, transport selection, streaming, transcript
  // projection, interactive requests, and message synchronization.
  // The host reads the provider-neutral session state and renders it.
  const session = useSession(workspaceId, sessionId);

  return (
    <>
      <SessionHeader workspaceId={workspaceId} sessionId={sessionId} />
      {/* Who this browser is acting as, above the conversation rather than in a
          settings page: in wrapper mode it is the ONLY thing separating this
          session from another signed-in person's. */}
      <ApplicationUserBadge workspaceId={workspaceId} />
      {/* A `require_approval` gate ends the agent's turn and nothing says so in
          the transcript — the session just goes quiet. Poll for it here, where
          the person who can decide is already looking. Rendered before the boot
          check on purpose: a gate raised earlier is still pending while the
          runtime is coming back up. */}
      <SessionApprovals workspaceId={workspaceId} sessionId={sessionId} />
      {session.phase !== 'ready' ? (
        <BootScreen
          stage={session.stage ?? undefined}
          reason={session.reason ?? undefined}
          failed={session.isError}
          onRetry={session.retry}
        />
      ) : (
        <WorkbenchTabs
          session={session}
          workspaceId={workspaceId}
          sessionId={sessionId}
        />
      )}
    </>
  );
}
