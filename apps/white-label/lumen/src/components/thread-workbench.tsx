'use client';

import { SessionApprovals } from '@/components/workbench/approvals-panel';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { useRuntimeRecovery } from '@/components/workbench/use-runtime-recovery';
import { CitationLayer } from '@/components/chat/citation-layer';
import { CITATION_REPAIR_PROMPT, unlinkedAnswerId } from '@/lib/cite-link';
import { registerLumenToolRows } from '@/components/chat/lumen-tool-row';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';
import { successToast } from '@kortix/ui/toast';
import { useAction, useMutation } from 'convex/react';
import { useEffect, useRef, useState } from 'react';

registerLumenToolRows();

/** One thread: the Kortix session behind it, streamed through Lumen's proxy. */
export function ThreadWorkbench({ projectId, sessionId, matterId }: { projectId: string; sessionId: string; matterId: Id<'matters'> }) {

  // One hook owns readiness, transport selection, streaming, transcript
  // projection, interactive requests, and message synchronization.
  // The host reads the provider-neutral session state and renders it.
  const session = useSession(projectId, sessionId);
  // One automatic restart when a connected runtime drops.
  useRuntimeRecovery(session);
  useOutputsToDocuments(matterId, sessionId, session.isBusy);
  useCitationRepair(session);
  useAuditDownloads(matterId);
  // A cited passage the lawyer sends back into the conversation ("Cite" in the Source panel).
  const [quote, setQuote] = useState<{ id: number; text: string } | null>(null);

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
        <CitationLayer matterId={matterId} onCite={(text) => setQuote((q) => ({ id: (q?.id ?? 0) + 1, text }))}>
          <SessionThread session={session} hideHeader quote={quote} className="flex-1" />
        </CitationLayer>
      )}
    </>
  );
}

/**
 * An answer whose citations are all bare "[n]" markers cannot be checked. When a
 * turn ends with one, the thread asks the agent once to rewrite it with citation
 * links. Once per answer, and never for the rewrite itself (UXR3-3).
 */
function useCitationRepair(session: ReturnType<typeof useSession>) {
  const asked = useRef(false);
  const wasBusy = useRef(session.isBusy);
  // A turn ended in this visit and its answer is not checked yet. The final text can land a render after the idle flip.
  const pending = useRef(false);
  const { isBusy, messages, send } = session;
  useEffect(() => {
    if (wasBusy.current && !isBusy) pending.current = true;
    wasBusy.current = isBusy;
    if (isBusy || !pending.current || asked.current) return;
    const id = unlinkedAnswerId(messages);
    if (!id) return;
    // Once per thread visit: a rewrite that still has bare markers keeps the banner.
    pending.current = false;
    asked.current = true;
    send(CITATION_REPAIR_PROMPT);
  }, [isBusy, messages, send]);
}

/**
 * When a turn ends, the files the Assistant wrote for the lawyer (the matter's
 * Outputs folder) become matter documents: citable, versioned, in the vault.
 */
function useOutputsToDocuments(matterId: Id<'matters'>, sessionId: string, busy: boolean) {
  const importOutputs = useAction(api.ingest.importOutputs);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    importOutputs({ matterId, kortixSessionId: sessionId })
      .then((added) => {
        for (const name of added) successToast(`${name} added to Documents`, { description: 'Open it in Documents, or cite it once it shows Ready.' });
      })
      .catch(() => undefined);
  }, [busy, matterId, sessionId, importOutputs]);
}

/**
 * Every download from this chat lands in the audit log as "Assistant file
 * downloaded". @kortix/ui's viewers and output cards each save a file through
 * a `<a download>` click on a blob URL; one capture listener on the document
 * sees all of them while the thread is open, with no hook in each viewer.
 */
function useAuditDownloads(matterId: Id<'matters'>) {
  const log = useMutation(api.audit.logAssistantDownload);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof HTMLAnchorElement ? e.target : null;
      if (!a?.hasAttribute('download') || !a.href.startsWith('blob:')) return;
      void log({ matterId, filename: a.download || 'file' }).catch(() => undefined);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [matterId, log]);
}
