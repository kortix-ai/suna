'use client';

/**
 * The browser's Kortix bearer: `matter.<matterId>`, the Lumen matter the
 * current page works in. It is not a secret. Identity is the Better Auth
 * cookie; the same-origin proxy (`/api/kortix`) checks matter access and swaps
 * this value for the member's project-scoped Kortix token. Every SDK path
 * (REST, SSE, session sync) sends `Authorization: Bearer <getToken()>`, so the
 * matter rides on every request without a custom header.
 */

let activeMatterId: string | null = null;

export function setActiveMatter(matterId: string | null): void {
  activeMatterId = matterId;
}

export function getSessionToken(): string | null {
  return activeMatterId ? `matter.${activeMatterId}` : null;
}

/** Authorization headers for the app's own server routes (preview, model, connections). */
export function authHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
