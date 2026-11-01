'use client';

import { listChromeConnections } from '@kortix/sdk';
import { chromeKeys } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * The web app's master switch for Kortix in Chrome. Off, no surface renders
 * and nothing calls /v1/chrome/*: no Settings page, no command-palette entry,
 * no sidebar row and no card in Apps and extensions. Off on every deployment
 * until launch: the probe below logged a 404 in the console on staging and
 * prod, where the API's KORTIX_CHROME_ENABLED is off. Set true to bring the
 * surfaces back where the API serves the routes.
 */
export const CHROME_UI_ENABLED = false;

/**
 * Whether this platform offers Kortix in Chrome at all. The API answers 404
 * on /v1/chrome/* where KORTIX_CHROME_ENABLED is off (staging, prod), so the
 * account-level surfaces — Settings → Kortix in Chrome and its command-palette
 * entry — show only once the browser list answers. Project surfaces read the
 * project's `chrome` flag and `CHROME_UI_ENABLED` instead.
 *
 * `enabled`: ask only while the surface that needs the answer is open.
 */
export function useChromeOffered(enabled = true): boolean {
  return useQuery({
    queryKey: chromeKeys.list(),
    queryFn: listChromeConnections,
    enabled: CHROME_UI_ENABLED && enabled,
    staleTime: 60_000,
    retry: false,
  }).isSuccess;
}
