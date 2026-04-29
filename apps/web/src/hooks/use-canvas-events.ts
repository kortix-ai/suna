'use client';

import { useQuery } from '@tanstack/react-query';

export interface CanvasEvent {
  type: 'canvas';
  kind: string;
  id: string;
  data: unknown;
}

interface CanvasEventsResponse {
  events: CanvasEvent[];
}

async function fetchCanvasEvents(sessionId: string): Promise<CanvasEvent[]> {
  const res = await fetch(`/api/v1/canvas/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  const data: CanvasEventsResponse = await res.json();
  return data.events ?? [];
}

/**
 * Poll canvas events for a session every 5 seconds.
 * Returns the latest list of canvas events emitted by the agent.
 */
export function useCanvasEvents(sessionId: string | null) {
  return useQuery({
    queryKey: ['canvas-events', sessionId],
    queryFn: () => fetchCanvasEvents(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 5000,
    staleTime: 2000,
  });
}
