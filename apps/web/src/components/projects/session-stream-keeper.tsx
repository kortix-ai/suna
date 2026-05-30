'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2/client';

import { getClientForUrl } from '@/lib/opencode-sdk';
import { getSandboxUrlForExternalId } from '@/stores/server-store';
import { getProjectSessionSandbox } from '@/lib/projects-client';
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
  // Reuses the session-sandbox query the route already populates (same key),
  // so this is almost always a cache hit — no extra round-trip.
  const { data: sandbox } = useQuery({
    queryKey: ['project', 'session-sandbox', projectId, sessionId],
    queryFn: () => getProjectSessionSandbox(projectId, sessionId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data && q.state.data.status === 'provisioning' ? 2_000 : false,
  });

  // Cloud sandboxes expose an OpenCode proxy derived purely from external_id.
  const externalId =
    sandbox && sandbox.status === 'active' ? sandbox.external_id : null;

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
async function runBackgroundStream(
  url: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  let retry = 0;
  while (!signal.aborted) {
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
    } catch (err) {
      if (signal.aborted) break;
      logger.warn('[session-stream-keeper] background stream error', {
        sessionId,
        error: String(err),
      });
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
