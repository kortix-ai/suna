'use client';

import { listChromeConnections } from '@kortix/sdk';
import { chromeKeys } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether this platform offers Kortix in Chrome at all. Until launch the API
 * answers 404 on /v1/chrome/* where KORTIX_CHROME_ENABLED is off (staging,
 * prod), so the account-level surfaces — Settings → Kortix in Chrome and its
 * command-palette entry — show only once the browser list answers. Project
 * surfaces read the project's `chrome` flag instead.
 *
 * `enabled`: ask only while the surface that needs the answer is open.
 */
export function useChromeOffered(enabled = true): boolean {
  return useQuery({
    queryKey: chromeKeys.list(),
    queryFn: listChromeConnections,
    enabled,
    staleTime: 60_000,
    retry: false,
  }).isSuccess;
}
