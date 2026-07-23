'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useServerStore } from '@/stores/server-store';
import { useServerHealth } from '@/features/files/hooks/use-server-health';
import { listListeningPorts } from '@/features/files/api/runtime-files';
import type { OutputItem } from '../shared/derive-panels';
import { portToAppOutput } from '../shared/port-apps';

/** Live listening ports as app OutputItems — polls fast while the session
 *  runs, slow when idle (a server can outlive the run), empty when the
 *  sandbox is unhealthy/asleep (an unreachable app row would be a lie).
 *
 *  `executeCompletions` (W1) is a monotonically-rising count of completed
 *  'run'-family tool calls (see `easy-panel.tsx`) — a server the agent just
 *  started should appear the instant its launch command finishes, not up to
 *  5s later on the next poll tick. Any rise refetches immediately; the
 *  interval above still owns the steady-state cadence. */
export function useRunningApps(isRunning: boolean, executeCompletions?: number): OutputItem[] {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const { data: health } = useServerHealth();
  const query = useQuery({
    queryKey: ['runtime-files', 'ports', serverUrl],
    queryFn: () => listListeningPorts(),
    enabled: !!serverUrl && health?.healthy === true,
    refetchInterval: isRunning ? 5_000 : 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const { refetch } = query;
  const prevCompletions = useRef(executeCompletions);
  useEffect(() => {
    const prev = prevCompletions.current;
    prevCompletions.current = executeCompletions;
    if (executeCompletions !== undefined && prev !== undefined && executeCompletions > prev) {
      refetch();
    }
  }, [executeCompletions, refetch]);

  return useMemo(() => (query.data ?? []).map((p) => portToAppOutput(p.port)), [query.data]);
}
