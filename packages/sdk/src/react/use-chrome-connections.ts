'use client';

/**
 * Kortix for Chrome hooks — TanStack React Query hooks for the browsers a person
 * connected with the Kortix Chrome extension:
 *   - useChromeConnections()       — the caller's browsers (online state, active sessions)
 *   - useUpdateChromeConnection()  — rename a browser, change its access mode or tab scope
 *   - useDeleteChromeConnection()  — disconnect a browser
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteChromeConnection,
  listChromeConnections,
  updateChromeConnection,
  type ChromeConnectionUpdate,
} from '../core/rest/projects-client';

export const chromeKeys = {
  all: ['chrome'] as const,
  list: () => [...chromeKeys.all, 'list'] as const,
};

/** The caller's browsers. Polls every 5 s; pass a faster `refetchInterval` while
 *  waiting for a connection, or `false` when only a one-time read matters. */
export function useChromeConnections(options: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: chromeKeys.list(),
    queryFn: listChromeConnections,
    staleTime: 2_000,
    refetchInterval: options.refetchInterval ?? 5_000,
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export function useUpdateChromeConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...update }: ChromeConnectionUpdate & { id: string }) => updateChromeConnection(id, update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chromeKeys.list() }),
  });
}

export function useDeleteChromeConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChromeConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chromeKeys.list() }),
  });
}
