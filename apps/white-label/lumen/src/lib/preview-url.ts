'use client';

import type { UiPreviewUrlResolver } from '@kortix/ui';

import { authHeaders, getSessionToken } from './session';

/**
 * One session preview URL from Lumen's server (`POST /api/preview-url`). The
 * route mints a short-lived Kortix preview share, so the URL carries no Kortix
 * token. The Preview tab and every sandbox link in the thread use it.
 */
export async function resolvePreviewUrl({
  projectId,
  sessionId,
  preview,
  targetUrl,
}: {
  projectId: string;
  sessionId: string;
  preview?: { port: number; path: string };
  targetUrl?: string;
}): Promise<{ url: string }> {
  const response = await fetch('/api/preview-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(getSessionToken()) },
    body: JSON.stringify({ projectId, sessionId, ...(preview ? { preview } : {}), ...(targetUrl ? { targetUrl } : {}) }),
  });
  const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error || 'Could not resolve preview URL');
  return { url: body.url };
}

/**
 * `UiProvider resolvePreviewUrl`: the session browser, the app preview and
 * inline sandbox links in @kortix/ui resolve through Lumen's server, never
 * through the SDK's token-in-URL default. Port 0 is a URL outside the sandbox:
 * null keeps the default, which opens it as it is.
 */
export const resolveLumenPreviewUrl: UiPreviewUrlResolver = async ({ projectId, sessionId, port, path }) =>
  port > 0 ? (await resolvePreviewUrl({ projectId, sessionId, preview: { port, path } })).url : null;
