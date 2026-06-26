'use client';

import { useEffect, useState } from 'react';
import type { StreamState, StreamStatus } from './types';

/**
 * Owns the EventSource connection to `/api/sessions/:id/events`. The server
 * route polls the Kortix backend (session / start / transcript) and emits
 * merged `snapshot` events plus a final `complete` when the agent is idle.
 *
 * Bump `reconnectKey` to re-open the stream after sending a follow-up — the
 * agent's new response then streams in, exactly like the core Kortix session.
 */
export function useSessionStream(
  sessionId: string,
  reconnectKey: number,
): {
  state: StreamState | null;
  status: StreamStatus;
} {
  const [state, setState] = useState<StreamState | null>(null);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    setStatus('connecting');
    const events = new EventSource(`/api/sessions/${sessionId}/events`);

    events.addEventListener('snapshot', (event) => {
      setStatus('live');
      setState(JSON.parse((event as MessageEvent).data) as StreamState);
    });
    events.addEventListener('complete', () => {
      setStatus('complete');
      events.close();
    });
    events.addEventListener('error', () => {
      setStatus((current) => (current === 'complete' ? current : 'closed'));
      events.close();
    });

    return () => events.close();
  }, [sessionId, reconnectKey]);

  return { state, status };
}
