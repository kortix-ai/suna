'use client';

import { parseLocalhostUrl } from '@kortix/sdk';
import { useCallback } from 'react';

import { useUiPreviewUrlResolver, type UiPreviewUrlResolver } from '../../providers/ui-provider';
import { useSessionIds } from '../../providers/session-ids';

/** The part of a browser tab this needs: `window.open('', '_blank')`'s result. */
export interface PreviewTab {
  opener: unknown;
  location: { replace(url: string): void };
  close(): void;
}

/**
 * Opens a sandbox address in a new tab at the host's URL (`UiProvider
 * resolvePreviewUrl`). The tab opens inside the click, before the resolver
 * runs, so no popup blocker drops it. A null answer loads `fallbackUrl`, the
 * SDK proxy URL. A failed resolver closes the tab.
 */
export function openHostPreview(
  resolve: UiPreviewUrlResolver,
  ids: { projectId: string; sessionId: string },
  localUrl: string,
  fallbackUrl: string,
  openTab: () => PreviewTab | null,
): boolean {
  const parsed = parseLocalhostUrl(localUrl);
  if (!parsed) return false;
  const tab = openTab();
  if (!tab) return false;
  tab.opener = null;
  resolve({ ...ids, port: parsed.port, path: parsed.path || '/', url: parsed.originalUrl }).then(
    (url) => tab.location.replace(url ?? fallbackUrl),
    () => tab.close(),
  );
  return true;
}

/**
 * A click handler for a link to a sandbox address; true when it opened the
 * tab. Null when the host has no resolver or no session is in scope: the
 * link's own proxied href is right.
 * With a resolver the proxied href points at the host's origin, which does
 * not serve the sandbox, so the click opens the host's URL instead.
 */
export function useOpenPreviewLink():
  | ((event: { preventDefault(): void } | null, localUrl: string, fallbackUrl: string) => boolean)
  | null {
  const resolve = useUiPreviewUrlResolver();
  const { projectId, sessionId } = useSessionIds();
  const handler = useCallback(
    (event: { preventDefault(): void } | null, localUrl: string, fallbackUrl: string) => {
      if (!resolve || !projectId || !sessionId) return false;
      const opened = openHostPreview(resolve, { projectId, sessionId }, localUrl, fallbackUrl, () =>
        window.open('', '_blank'),
      );
      if (opened) event?.preventDefault();
      return opened;
    },
    [resolve, projectId, sessionId],
  );
  return resolve && projectId && sessionId ? handler : null;
}
