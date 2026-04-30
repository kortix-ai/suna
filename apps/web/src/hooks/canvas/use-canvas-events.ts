'use client';

import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface CanvasEvent {
  type: 'canvas';
  kind: string;
  id: string;
  data: unknown;
}

async function fetchCanvasEvents(sessionId: string): Promise<CanvasEvent[]> {
  const res = await backendApi.get<{ events: CanvasEvent[] }>(
    `/canvas/${encodeURIComponent(sessionId)}`,
  );
  return res.data?.events ?? [];
}

/** Poll canvas events for a session every 5 seconds. */
export function useCanvasEvents(sessionId: string | null) {
  return useQuery({
    queryKey: ['canvas-events', sessionId],
    queryFn: () => fetchCanvasEvents(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 5000,
    staleTime: 2000,
  });
}
