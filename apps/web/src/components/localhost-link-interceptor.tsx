'use client';

/**
 * Global catch-all that intercepts clicks on ANY <a> tag whose href points to
 * localhost:PORT (or 127.0.0.1:PORT) and opens it in the preview tab instead
 * of navigating the browser to an unreachable address.
 *
 * Also intercepts clicks on already-proxied URLs (e.g. links whose href was
 * rewritten by the markdown renderer to go through the backend preview proxy)
 * so that they open as preview tabs instead of navigating the top-level page.
 *
 * Mount once at the app root — it uses a single delegated listener on
 * `document` so every link in the tree is covered automatically, including
 * links rendered by tool views, JSON viewers, markdown, etc.
 */

import { useEffect } from 'react';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  isProxiableLocalhostUrl,
  parseLocalhostUrl,
  proxyUrlToInternal,
  isPreviewUrl,
  isWebProxyUrl,
  parseWebProxyUrl,
  buildWebProxyUrl,
  toInternalUrl,
} from '@/lib/utils/sandbox-url';
import { openTabAndNavigate } from '@/stores/tab-store';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useIntegrationConnectStore } from '@/stores/integration-connect-store';

/**
 * Check if a URL is a connector connect URL (e.g. /connectors?connect=github&sandbox_id=xxx).
 * Returns { appSlug, sandboxId } if matched, null otherwise.
 */
function parseIntegrationConnectUrl(href: string): { appSlug: string; sandboxId?: string } | null {
  try {
    const url = new URL(href);
    // Must be pointing to /integrations with a ?connect= param
    if (url.pathname !== '/connectors') return null;
    const connectApp = url.searchParams.get('connect');
    if (!connectApp) return null;
    return {
      appSlug: connectApp,
      sandboxId: url.searchParams.get('sandbox_id') || undefined,
    };
  } catch {
    return null;
  }
}

export function LocalhostLinkInterceptor() {
  const { activeServer, subdomainOpts, rewritePortPath } = useSandboxProxy();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      // Only intercept plain left-clicks (no modifier keys)
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      // Walk up from the click target to find the nearest <a>
      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;

      const href = anchor.href; // resolved absolute URL
      if (!href) return;

      // ── Case 0: Connector connect URL ──
      // Intercept /connectors?connect=<app>&sandbox_id=<id> links and trigger
      // the Pipedream OAuth popup inline instead of navigating to a new tab.
      const integrationConnect = parseIntegrationConnectUrl(href);
      if (integrationConnect) {
        e.preventDefault();
        e.stopPropagation();
        const store = useIntegrationConnectStore.getState();
        store.triggerConnect(integrationConnect.appSlug, integrationConnect.sandboxId);
        return;
      }

      // Never intercept links pointing at the app itself (same origin)
      try {
        if (new URL(href).origin === window.location.origin) return;
      } catch { /* not a valid URL, skip */ }

      // Resolve the proxy URL using the active server
      // ── Case 1: Fresh localhost:PORT URL (not yet proxied) ──
      if (isProxiableLocalhostUrl(href)) {
        const parsed = parseLocalhostUrl(href);
        if (!parsed) return;

        const { port, path } = parsed;
        const proxyUrl = rewritePortPath(port, path);
        const internalUrl = toInternalUrl(port, path);

        e.preventDefault();
        e.stopPropagation();

        openTabAndNavigate({
          id: `preview:${port}`,
          title: `localhost:${port}`,
          type: 'preview',
          href: `/p/${port}`,
          metadata: enrichPreviewMetadata({ url: proxyUrl, port, originalUrl: internalUrl, path }),
        });
        return;
      }

      // ── Case 2: Already-proxied URL (subdomain or path-based) ──
      // The href is something like http://p3210-kortix-sandbox.localhost:8008/
      // or http://localhost:8008/v1/p/.../proxy/3210/
      // which would navigate the browser away from the app. Instead, open as tab.
      if (isPreviewUrl(href)) {
        const internal = proxyUrlToInternal(href, activeServer?.mappedPorts);
        if (internal) {
          const parsed = parseLocalhostUrl(internal);
          if (parsed) {
            const { port, path } = parsed;
            const proxyUrl = rewritePortPath(port, path);
            const internalUrl = toInternalUrl(port, path);

            e.preventDefault();
            e.stopPropagation();

            openTabAndNavigate({
              id: `preview:${port}`,
              title: `localhost:${port}`,
              type: 'preview',
              href: `/p/${port}`,
              metadata: enrichPreviewMetadata({ url: proxyUrl, port, originalUrl: internalUrl, path }),
            });
            return;
          }
        }
      }

      // ── Case 3: Web proxy URL (external site proxied through /web-proxy/) ──
      // The href goes through /web-proxy/{scheme}/{host}/{path} — would navigate
      // the browser to the backend proxy endpoint. Open in preview tab instead.
      if (isWebProxyUrl(href)) {
        const originalUrl = parseWebProxyUrl(href);
        if (originalUrl) {
          const proxyUrl = buildWebProxyUrl(originalUrl, subdomainOpts);
          if (proxyUrl) {
            e.preventDefault();
            e.stopPropagation();

            openTabAndNavigate({
              id: 'preview:web-proxy',
              title: new URL(originalUrl).hostname,
              type: 'preview',
              href: '/web-proxy',
              metadata: enrichPreviewMetadata({ url: proxyUrl, originalUrl }),
            });
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
