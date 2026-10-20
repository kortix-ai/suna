'use client';

import type { UiPreviewUrlResolver } from '@kortix/ui';

import { authHeaders, getSessionToken } from './session';

/**
 * Wrapper mode's preview URLs for the session browser (`UiProvider
 * resolvePreviewUrl`). Lumen's origin is not the Kortix backend, and the
 * browser holds only Lumen's own session, so `POST /api/preview-url` resolves
 * the URL on the server and appends a project-scoped preview token. The Lumen
 * session token never appears in a frame URL.
 */
export const resolveWrapperPreviewUrl: UiPreviewUrlResolver = async ({ projectId, sessionId, port, path, url }) => {
  const target = port > 0 ? { preview: { port, path } } : { targetUrl: url };
  const response = await fetch('/api/preview-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(getSessionToken()) },
    body: JSON.stringify({ projectId, sessionId, ...target }),
  });
  const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error || 'Could not resolve preview URL');
  return body.url;
};
