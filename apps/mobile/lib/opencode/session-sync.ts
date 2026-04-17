/**
 * Session Sync Hook — hydrates sync store with messages on mount,
 * with a polling fallback when SSE is broken during busy sessions.
 *
 * After hydration, the SSE event stream keeps the store updated.
 */

import { useEffect, useRef } from 'react';
import { log } from '@/lib/logger';
import { getAuthToken } from '@/api/config';
import { useSyncStore } from './sync-store';
import type { MessageWithParts, SessionStatus } from './types';

// Polling interval while a session is busy. Matches web 1caea48.
const POLL_INTERVAL_MS = 3_000;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Hydrate a session's messages into the sync store.
 * Call this when navigating to a session page.
 *
 * Note: pending questions/permissions are restored by SessionPage's
 * self-heal effect (polling GET /question when a running question tool
 * part is detected but no pending question is in the store).
 */
export function useSessionSync(
  sandboxUrl: string | undefined,
  sessionId: string | undefined,
) {
  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sandboxUrl || !sessionId) return;
    if (hydratedRef.current === sessionId) return;

    let cancelled = false;

    async function fetchMessages() {
      try {
        log.log('📥 [SessionSync] Fetching messages for:', sessionId);
        const res = await fetch(`${sandboxUrl}/session/${sessionId}/message`, {
          headers: await authHeaders(),
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch messages: ${res.status}`);
        }

        const messages: MessageWithParts[] = await res.json();

        if (!cancelled) {
          useSyncStore.getState().hydrate(sessionId!, messages);
          hydratedRef.current = sessionId!;
          log.log('✅ [SessionSync] Hydrated', messages.length, 'messages');
        }
      } catch (error) {
        log.error('❌ [SessionSync] Failed to fetch messages:', error);
      }
    }

    fetchMessages();

    return () => {
      cancelled = true;
    };
  }, [sandboxUrl, sessionId]);

  // ── Polling fallback ────────────────────────────────────────────────────
  // When the session is busy, SSE should deliver streaming events. But if
  // SSE is broken (network blip, 502, ERR_QUIC_PROTOCOL_ERROR), no events
  // arrive and the UI is stuck on "Considering next steps..." forever.
  // As a fallback, poll for messages every 3s while the session is busy.
  // The poll stops as soon as the session goes idle or the hook unmounts.
  //
  // The poll skips fetching if SSE is still delivering data (part count
  // grew between polls). Matches web apps/web/src/hooks/opencode/use-session-sync.ts.
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPartCountRef = useRef(0);
  // Subscribe to status so the effect re-runs when busy/idle flips.
  const currentStatus = useSyncStore((s) =>
    sessionId ? s.sessionStatus[sessionId] : undefined,
  );

  useEffect(() => {
    if (!sandboxUrl || !sessionId) return;

    const isBusyNow =
      currentStatus?.type === 'busy' || currentStatus?.type === 'retry';

    if (!isBusyNow) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    if (pollTimerRef.current) return; // already polling

    // Count parts across all messages in the session. On mobile, parts live
    // on `MessageWithParts.parts` (inline), not a separate map like on web.
    const countParts = (): number => {
      const msgs = useSyncStore.getState().messages[sessionId] ?? [];
      let count = 0;
      for (const m of msgs) count += m.parts?.length ?? 0;
      return count;
    };
    lastPartCountRef.current = countParts();

    pollTimerRef.current = setInterval(async () => {
      const st = useSyncStore.getState().sessionStatus[sessionId];
      if (st?.type !== 'busy' && st?.type !== 'retry') {
        // Session went idle — stop polling
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        return;
      }

      // Skip fetch if SSE is delivering data (part count grew)
      const currentCount = countParts();
      if (currentCount > lastPartCountRef.current) {
        lastPartCountRef.current = currentCount;
        return;
      }

      // SSE appears stalled — fetch messages AND session status from server.
      // Without updating status, a dead SSE means session.idle never arrives
      // and the UI stays stuck on "busy" forever.
      try {
        const headers = await authHeaders();
        const [msgRes, statusRes] = await Promise.all([
          fetch(`${sandboxUrl}/session/${sessionId}/message`, { headers }).catch(
            () => null,
          ),
          fetch(`${sandboxUrl}/session/status`, { headers }).catch(() => null),
        ]);

        if (msgRes?.ok) {
          const messages = (await msgRes.json()) as MessageWithParts[];
          useSyncStore.getState().hydrate(sessionId, messages);
        }

        if (statusRes?.ok) {
          const statuses = (await statusRes.json()) as Record<
            string,
            SessionStatus
          >;
          const serverStatus = statuses[sessionId];
          if (serverStatus) {
            useSyncStore.getState().setStatus(sessionId, serverStatus);
          } else {
            // Session not in busy statuses map → it's idle
            useSyncStore
              .getState()
              .setStatus(sessionId, { type: 'idle' } as SessionStatus);
          }
        }
      } catch {
        // Silently ignore — will retry on next interval
      }
      lastPartCountRef.current = countParts();
    }, POLL_INTERVAL_MS);
  }, [sandboxUrl, sessionId, currentStatus?.type]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);
}
