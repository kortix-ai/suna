'use client';

import { SessionApprovals } from '@/components/workbench/approvals-panel';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { useRuntimeRecovery } from '@/components/workbench/use-runtime-recovery';
import { CitationLayer } from '@/components/chat/citation-layer';
import '@/components/chat/lumen-tool-row';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';
import { successToast } from '@kortix/ui/toast';
import { useAction } from 'convex/react';
import { useEffect, useRef } from 'react';

/** One thread: the Kortix session behind it, streamed through Lumen's proxy. */
export function ThreadWorkbench({ projectId, sessionId, matterId }: { projectId: string; sessionId: string; matterId: Id<'matters'> }) {

  // One hook owns readiness, transport selection, streaming, transcript
  // projection, interactive requests, and message synchronization.
  // The host reads the provider-neutral session state and renders it.
  const session = useSession(projectId, sessionId);
  // One automatic restart when a connected runtime drops.
  useRuntimeRecovery(session);
  useOutputsToDocuments(matterId, session.isBusy);

  return (
    <>
      <SessionHeader projectId={projectId} sessionId={sessionId} runtimeReady={session.phase === 'ready'} />
      {/* A `require_approval` gate ends the agent's turn and nothing says so in
          the transcript — the session just goes quiet. Poll for it here, where
          the person who can decide is already looking; the strip shows only
          when something waits. Rendered before the boot check on purpose: a
          gate raised earlier is still pending while the runtime is coming back up. */}
      <SessionApprovals
        projectId={projectId}
        sessionId={sessionId}
        waitingInChat={session.questions.length + session.permissions.length}
      />
      {session.phase !== 'ready' ? (
        <BootScreen
          stage={session.stage ?? undefined}
          reason={session.reason ?? undefined}
          failed={session.isError}
          onRetry={session.retry}
        />
      ) : (
        // A lawyer sees the conversation and its sources: @kortix/ui's
        // SessionThread (the thread apps/web renders) over the one useSession
        // result. No repo views, no scope chips, no second chat hook.
        <CitationLayer matterId={matterId}>
          <SessionThread session={session} hideHeader className="flex-1" />
        </CitationLayer>
      )}
    </>
  );
}

/**
 * When a turn ends, the files the Assistant wrote for the lawyer (the matter's
 * Outputs folder) become matter documents: citable, versioned, in the vault.
 */
function useOutputsToDocuments(matterId: Id<'matters'>, busy: boolean) {
  const importOutputs = useAction(api.ingest.importOutputs);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    importOutputs({ matterId })
      .then((added) => {
        for (const name of added) successToast(`${name} added to Documents`, { description: 'Open it in Documents, or cite it once it shows Ready.' });
      })
      .catch(() => undefined);
  }, [busy, matterId, importOutputs]);
}
