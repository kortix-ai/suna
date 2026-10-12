'use client';

/**
 * Kortix Browser hooks — TanStack React Query hooks for the browsers a person
 * connected with the Kortix Chrome extension:
 *   - useBrowsers()       — the caller's browsers (online state, active sessions)
 *   - useUpdateBrowser()  — rename a browser, change its access mode or tab scope
 *   - useDeleteBrowser()  — disconnect a browser
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteBrowser,
  listBrowsers,
  updateBrowser,
  type KortixBrowserUpdate,
} from '../core/rest/projects-client';

export const browserKeys = {
  all: ['browsers'] as const,
  list: () => [...browserKeys.all, 'list'] as const,
};

/** The caller's browsers. Polls every 5 s; pass a faster `refetchInterval` while
 *  waiting for a connection, or `false` when only a one-time read matters. */
export function useBrowsers(options: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: browserKeys.list(),
    queryFn: listBrowsers,
    staleTime: 2_000,
    refetchInterval: options.refetchInterval ?? 5_000,
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export function useUpdateBrowser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...update }: KortixBrowserUpdate & { id: string }) => updateBrowser(id, update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: browserKeys.list() }),
  });
}

export function useDeleteBrowser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteBrowser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: browserKeys.list() }),
  });
}
