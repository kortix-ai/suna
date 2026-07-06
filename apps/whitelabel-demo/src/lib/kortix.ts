'use client';

import { BRAND, resolveApiUrl } from '@/config/brand';
import { configureKortix, createKortix } from '@kortix/sdk';
import { getSessionToken } from './session';

/**
 * The white-label's single seam to Kortix: the official `@kortix/sdk`. No raw
 * HTTP, no OpenCode imports. One token supplied via `getToken` — a pasted
 * Kortix API key in direct mode, or Lumen's own session token in wrapper mode
 * (see `configureWrapperMode` below). Swap `BRAND.apiUrl` + the key to
 * re-point direct mode at any Kortix deployment.
 */

const TOKEN_KEY = 'kortix_api_key';

export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setApiKey(key: string): void {
  window.localStorage.setItem(TOKEN_KEY, key.trim());
}

export function clearApiKey(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * The configured client. `createKortix` wires the platform seam once on
 * import, defaulting to direct mode. All of its methods read the platform
 * config LIVE on every call (not at creation time), so `configureWrapperMode`
 * below can safely re-point the same `kortix` object at the wrapper proxy
 * later — no consumer needs to re-import or re-create anything.
 */
export const kortix = createKortix({
  backendUrl: BRAND.apiUrl,
  getToken: async () => getApiKey(),
});

/**
 * Re-point the SDK at the same-origin BFF proxy once `Providers` confirms
 * wrapper mode is on (`GET /api/mode`). Direct mode never calls this — `kortix`
 * stays wired to `BRAND.apiUrl` + the pasted API key, unchanged.
 */
export function configureWrapperMode(): void {
  configureKortix({
    backendUrl: resolveApiUrl(true),
    getToken: async () => getSessionToken(),
  });
}
