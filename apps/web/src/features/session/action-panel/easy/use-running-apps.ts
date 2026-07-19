'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useServerStore } from '@/stores/server-store';
import { useServerHealth } from '@/features/files/hooks/use-server-health';
import { listListeningPorts } from '@/features/files/api/runtime-files';
import type { OutputItem } from '../shared/derive-panels';
import { portToAppOutput } from '../shared/port-apps';

/** Live listening ports as app OutputItems — polls fast while the session
 *  runs, slow when idle (a server can outlive the run), empty when the
 *  sandbox is unhealthy/asleep (an unreachable app row would be a lie). */
export function useRunningApps(isRunning: boolean): OutputItem[] {
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
  return useMemo(() => (query.data ?? []).map((p) => portToAppOutput(p.port)), [query.data]);
}
