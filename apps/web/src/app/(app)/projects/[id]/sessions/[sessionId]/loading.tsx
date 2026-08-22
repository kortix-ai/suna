'use client';

import { useParams } from 'next/navigation';

import ProjectHomeLoading from '../../loading';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import { readStartStash } from '@kortix/sdk/react';

/**
 * Navigation Suspense boundary for /projects/[id]/sessions/[sessionId].
 *
 * The session layout is dynamic (it resolves the tab title on the server), so
 * every navigation into a session paints a loading boundary for the length of
 * that round-trip (~60–100 ms). Without a boundary of its own this segment
 * inherited ../../loading.tsx — ProjectHome's skeleton — which, on the one
 * navigation people make most (home composer → brand-new session), put a
 * centered skeleton BETWEEN the home page and the instant session shell: two
 * frames of grey bars flashing where the user's own message was about to be.
 *
 * So on that navigation this boundary renders the instant session shell
 * itself — the very component the page mounts first — with the first prompt
 * from the producer's preview store. The hand-over to the page is then
 * pixel-identical: same bubble, same waiting row, same composer. Every other
 * navigation into a session (sidebar, back/forward) has no preview and keeps
 * the project skeleton it always had.
 */
export default function SessionLoading() {
  const params = useParams<{ id: string; sessionId: string }>();
  const projectId = params?.id;
  const sessionId = params?.sessionId;
  const preview = useFirstPromptPreviewStore((s) =>
    sessionId ? (s.previewBySession[sessionId] ?? null) : null,
  );
  if (!projectId || !sessionId || !preview) return <ProjectHomeLoading />;
  // The producer stashed the picked agent alongside the prompt (see
  // `writeStartStash` on the home composer) — hand it to the shell so the
  // agent picker names the session's real agent on THIS boundary's first
  // frame, not the project default. Safe to read here: the `preview` gate
  // above means this branch only renders on a soft navigation, where the
  // in-memory store (and therefore sessionStorage) is already client-side.
  return (
    <InstantSessionShell
      projectId={projectId}
      sessionId={sessionId}
      stage="provisioning"
      boundAgentName={readStartStash(sessionId)?.agent ?? null}
    />
  );
}
