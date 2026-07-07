'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getClientForUrl } from '@/lib/opencode-sdk';
import { getSandboxUrlForExternalId } from '@/stores/server-store';
import { listProjectSessions } from '@kortix/sdk/projects-client';
import { openEventStream, type OpenCodeEvent } from '@kortix/sdk/event-stream';
import type { Event as SyncStoreEvent } from '@kortix/sdk/opencode-client';
import { useSyncStore } from '@/stores/opencode-sync-store';
import {
  useProjectSessionTabsStore,
  CUSTOMIZE_TAB_ID,
} from '@/stores/project-session-tabs-store';
import { logger } from '@/lib/logger';

const EMPTY: string[] = [];

/**
 * Keeps EVERY open project session connected to its own sandbox at the same
 * time — so a session you've navigated away from never "stops".
 *
 * The session you're currently viewing already has a full SSE stream (mounted
 * by its route via OpenCodeEventStreamProvider). This component keeps a
 * lightweight background SSE stream open for every OTHER open session tab,
 * piping live events straight into the session-id-keyed sync store. Each open
 * session therefore stays live in parallel: its agent keeps streaming, status
 * stays current, and switching to it shows up-to-date state instantly.
 *
 * Deliberately additive and isolated:
 *   - One stream per sandbox, each via its OWN per-URL client (getClientForUrl).
 *   - It only writes to the sync store — never the React Query cache (except
 *     the session-list invalidation on park, below), never the global active
 *     server — so it cannot disturb the active session.
 *   - The currently-viewed session is skipped (its route owns that stream).
 *   - Streams ride the SDK's `openEventStream` primitive (connect timeout,
 *     idle-heartbeat watchdog, exponential backoff), NOT a hand-rolled loop —
 *     so a sandbox that is genuinely gone (archived/stopped while the session
 *     list still claims `running`) PARKS after a bounded number of hard
 *     failures instead of retrying 503s forever. On park we invalidate the
 *     project's session list so the stale `running` status corrects itself
 *     and this component unmounts the dead stream on the next render.
 */
export function SessionStreamKeeper({ projectId }: { projectId: string }) {
  const tabs = useProjectSessionTabsStore((s) => s.tabsByProject[projectId]) ?? EMPTY;
  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  return (
    <>
      {tabs
        .filter((id) => id !== CUSTOMIZE_TAB_ID && id !== activeSessionId)
        .map((id) => (
          <BackgroundSessionStream key={id} projectId={projectId} sessionId={id} />
        ))}
    </>
  );
}

function BackgroundSessionStream({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const queryClient = useQueryClient();

  // Derive the live sandbox URL from the project's session LIST (one shared
  // query across all tabs — React Query dedupes the key), NOT a per-tab call.
  // CRITICAL: a background tab must NEVER call /start — that provisions/wakes/
  // ensures and, multiplied across many open tabs, floods the API into timeouts.
  // We just piggyback on the already-loaded list to find a running session's
  // external_id; provisioning/stopped tabs simply don't background-stream until
  // you actually open them.
  const { data: sessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const session = sessions?.find((s) => s.session_id === sessionId);
  const externalId =
    session?.status === 'running'
      ? session.sandbox_url?.match(/\/p\/([^/]+)\//)?.[1] ?? null
      : null;

  useEffect(() => {
    if (!externalId) return;
    const url = getSandboxUrlForExternalId(externalId);
    if (!url) return;

    const handle = openEventStream({
      client: getClientForUrl(url),
      onEvent: (e: OpenCodeEvent) => {
        try {
          // The stream's event union is a superset of the sync store's `Event`
          // (the SDK adds a few members the store simply ignores in its switch)
          // — same boundary cast the previous hand-rolled loop made.
          useSyncStore.getState().applyEvent(e as unknown as SyncStoreEvent);
        } catch {
          /* one bad event shouldn't kill the stream */
        }
      },
      onParked: ({ consecutiveFailures, lastError }) => {
        // The sandbox is genuinely unreachable (archived/stopped/dead) — the
        // stream has permanently stopped retrying. Refresh the session list so
        // its stale `running` status corrects itself; this component then drops
        // to `externalId = null` on the next render and stays quiet.
        logger.warn('[session-stream-keeper] background stream parked — sandbox unreachable', {
          sessionId,
          consecutiveFailures,
          error: String(lastError),
        });
        void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      },
    });
    return () => handle.close();
  }, [externalId, sessionId, projectId, queryClient]);

  return null;
}
