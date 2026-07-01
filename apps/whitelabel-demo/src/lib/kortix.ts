'use client';

import { BRAND } from '@/config/brand';
import { createKortix } from '@kortix/sdk';

/**
 * The white-label's single seam to Kortix: the official `@kortix/sdk`. No raw
 * HTTP, no OpenCode imports. One token (a Kortix API key) supplied via `getToken`.
 * Swap `BRAND.apiUrl` + the key to re-point at any Kortix deployment.
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

/** The configured client. `createKortix` wires the platform seam once on import. */
export const kortix = createKortix({
  backendUrl: BRAND.apiUrl,
  getToken: async () => getApiKey(),
});
