'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Event as OpenCodeEvent } from '@kortix/sdk/opencode-client';

import { getClientForUrl } from '@/lib/opencode-sdk';
import { getSandboxUrlForExternalId } from '@/stores/server-store';
import { listProjectSessions } from '@kortix/sdk/projects-client';
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
 *   - It only writes to the sync store — never the React Query cache, never the
 *     global active server — so it cannot disturb the active session.
 *   - The currently-viewed session is skipped (its route owns that stream).
 *   - Worst case (sandbox unreachable) it simply retries/no-ops.
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
    const controller = new AbortController();
    void runBackgroundStream(url, sessionId, controller.signal);
    return () => controller.abort();
  }, [externalId, sessionId]);

  return null;
}

/**
 * Consume a sandbox's SSE event stream and feed it into the sync store, with
 * exponential-backoff reconnect. Mirrors the active stream's consume loop but
 * intentionally minimal: no coalescing, no query-cache writes, no
 * notifications — just keep the session live.
 */
/**
 * A background stream that fails to even connect this many times in a row —
 * without a single event and without holding the connection open — is treated
 * as a stopped/unreachable sandbox and abandoned, rather than reconnecting
 * forever. A stopped box answers /global/event with 503 (or 302→auth0 CORS)
 * every time; without this, every open-but-stopped tab hammered its sandbox
 * indefinitely, producing a wall of `/global/event` 503s on any session page.
 * If the box comes back, the session-list query (30s) re-derives externalId and
 * BackgroundSessionStream's effect remounts a fresh stream — so giving up is
 * safe, not permanent.
 */
const BACKGROUND_STREAM_GIVE_UP_AFTER = 4;
/** A connection open at least this long counts as "real box, just dropped" — reconnect. */
const BACKGROUND_STREAM_ALIVE_MS = 10_000;

async function runBackgroundStream(
  url: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  let retry = 0;
  let connectFailures = 0;
  while (!signal.aborted) {
    const startedAt = Date.now();
    let sawEvent = false;
    try {
      const client = getClientForUrl(url);
      const result = await client.global.event({
        signal,
        sseDefaultRetryDelay: 3000,
        sseMaxRetryDelay: 30000,
      } as Parameters<typeof client.global.event>[0]);
      const { stream } = result;
      for await (const event of stream) {
        if (signal.aborted) break;
        sawEvent = true;
        const raw = event as unknown as { payload?: OpenCodeEvent } & OpenCodeEvent;
        const e = (raw && typeof raw === 'object' && 'payload' in raw
          ? raw.payload
          : raw) as OpenCodeEvent | undefined;
        if (!e?.type) continue;
        try {
          useSyncStore.getState().applyEvent(e);
        } catch {
          /* one bad event shouldn't kill the stream */
        }
      }
      retry = 0;
      connectFailures = 0;
    } catch (err) {
      if (signal.aborted) break;
      // Distinguish a real box that dropped (connected a while / streamed
      // events) from a stopped box that fails fast every time.
      if (sawEvent || Date.now() - startedAt >= BACKGROUND_STREAM_ALIVE_MS) {
        connectFailures = 0;
      } else {
        connectFailures++;
      }
      logger.warn('[session-stream-keeper] background stream error', {
        sessionId,
        connectFailures,
        error: String(err),
      });
      if (connectFailures >= BACKGROUND_STREAM_GIVE_UP_AFTER) {
        logger.warn('[session-stream-keeper] abandoning unreachable background sandbox', {
          sessionId,
          connectFailures,
        });
        break;
      }
    }

    if (signal.aborted) break;
    const delay = Math.min(1000 * 2 ** Math.min(retry++, 5), 30000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
