'use client';

/**
 * Global catch-all that intercepts clicks on any <a> whose href points to
 * `localhost:PORT` (or 127.0.0.1:PORT) or an already-proxied preview URL.
 *
 * Routing:
 *
 *   - Plain left-click on a `/projects/[id]/sessions/[sessionId]` page →
 *     populate that session's preview tab (`session-preview:{sessionId}`
 *     in `useTabStore`), flip the side panel to Browser view, and let
 *     `PreviewTabContent` render the iframe through the proxy.
 *
 *   - Cmd / Ctrl / Shift / middle-click → the listener doesn't fire; the
 *     anchor falls back to native browser behavior. Since the `href` was
 *     already proxy-rewritten upstream (by the markdown renderer or
 *     wherever the URL was emitted), the new tab loads the proxy URL.
 *
 *   - Off a session page (e.g. dashboards, settings) → window.open the
 *     proxy URL. There's no in-app surface to host the iframe there.
 *
 *   - The in-panel `PreviewTabContent` has its own "open externally"
 *     button for explicitly popping the current iframe out to a new tab.
 *
 * Mount once at the app root — uses a single delegated `click` listener
 * on `document`, so every link in the tree is covered (markdown, tool
 * views, JSON viewers, etc.).
 */

import { useEffect } from 'react';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  buildWebProxyUrl,
  isPreviewUrl,
  isProxiableLocalhostUrl,
  isWebProxyUrl,
  parseLocalhostUrl,
  parseWebProxyUrl,
  proxyUrlToInternal,
  toInternalUrl,
} from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import {
  getActivePanelSessionId,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useTabStore } from '@/stores/tab-store';

// The session's panel is keyed by the OpenCode chatSessionId (registered by the
// active SessionLayout), NOT the Kortix session id in the URL — those differ,
// so the URL id would write to a key nothing reads (panel opens but the Browser
// tab never selects). Null off-session → fall back to opening externally.
function getCurrentSessionId(): string | null {
  return getActivePanelSessionId();
}

export function LocalhostLinkInterceptor() {
  const { activeServer, subdomainOpts, rewritePortPath } = useSandboxProxy();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      // Modifier-clicks fall through to native new-tab behavior.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;

      const href = anchor.href;
      if (!href) return;

      try {
        if (new URL(href).origin === window.location.origin) return;
      } catch { /* not a valid URL, skip */ }

      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      /** Open URL into the active session's right-side panel. */
      const openInPanel = (
        sessionId: string,
        meta: { url: string; port: number; originalUrl: string; path: string },
      ) => {
        consume();
        useTabStore.getState().openTab({
          id: sessionPreviewTabId(sessionId),
          title: meta.port ? `localhost:${meta.port}` : safeHostname(meta.originalUrl),
          type: 'preview',
          href: window.location.pathname,
          metadata: enrichPreviewMetadata(meta),
        });
        useSessionBrowserStore.getState().setView(sessionId, 'browser');
        useKortixComputerStore.getState().setIsSidePanelOpen(true);
      };

      /** Off-session fallback: window.open the proxy URL. */
      const openExternally = (url: string) => {
        consume();
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      };

      // ── Case 1: Fresh localhost:PORT URL (not yet proxied) ──
      if (isProxiableLocalhostUrl(href)) {
        const parsed = parseLocalhostUrl(href);
        if (!parsed) return;
        const { port, path } = parsed;
        const proxied = rewritePortPath(port, path);
        const internal = toInternalUrl(port, path);
        const sessionId = getCurrentSessionId();
        if (sessionId) {
          openInPanel(sessionId, { url: proxied, port, originalUrl: internal, path });
        } else {
          openExternally(proxied);
        }
        return;
      }

      // ── Case 2: Already-proxied URL ──
      if (isPreviewUrl(href)) {
        const internal = proxyUrlToInternal(href, activeServer?.mappedPorts);
        if (internal) {
          const parsed = parseLocalhostUrl(internal);
          if (parsed) {
            const { port, path } = parsed;
            const proxied = rewritePortPath(port, path);
            const sessionId = getCurrentSessionId();
            if (sessionId) {
              openInPanel(sessionId, {
                url: proxied,
                port,
                originalUrl: toInternalUrl(port, path),
                path,
              });
            } else {
              openExternally(proxied);
            }
            return;
          }
        }
      }

      // ── Case 3: /web-proxy/{scheme}/{host}/{path} URL ──
      if (isWebProxyUrl(href)) {
        const originalUrl = parseWebProxyUrl(href);
        if (originalUrl) {
          const proxied = buildWebProxyUrl(originalUrl, subdomainOpts);
          if (proxied) {
            const sessionId = getCurrentSessionId();
            if (sessionId) {
              openInPanel(sessionId, { url: proxied, port: 0, originalUrl, path: '/' });
            } else {
              openExternally(proxied);
            }
            return;
          }
        }
      }
    }

    document.addEventListener('click', handleClick, { capture: true });
    return () => document.removeEventListener('click', handleClick, { capture: true });
  }, [activeServer, rewritePortPath, subdomainOpts]);

  return null;
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return 'preview'; }
}
