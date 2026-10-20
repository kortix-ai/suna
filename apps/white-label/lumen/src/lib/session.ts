'use client';

/**
 * The browser's Kortix bearer: `ws.<workspaceId>`, the Lumen workspace the
 * current page works in. It is not a secret. Identity is the Better Auth
 * cookie; the same-origin proxy (`/api/kortix`) checks membership and swaps
 * this value for the member's project-scoped Kortix token. Every SDK path
 * (REST, SSE, session sync) sends `Authorization: Bearer <getToken()>`, so the
 * workspace rides on every request without a custom header.
 */

let activeWorkspaceId: string | null = null;

export function setActiveWorkspace(workspaceId: string | null): void {
  activeWorkspaceId = workspaceId;
}

export function getSessionToken(): string | null {
  return activeWorkspaceId ? `ws.${activeWorkspaceId}` : null;
}

/** Authorization headers for the app's own server routes (preview, model, connections). */
export function authHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
