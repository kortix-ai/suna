'use client';

/**
 * Route a `localhost:PORT` click in the transcript into the session's own
 * right-hand panel, instead of navigating the whole app away to it.
 *
 * A running port is a deliverable, and a deliverable belongs beside the
 * conversation that produced it — the same place a finished file opens. The
 * old behavior (`openTabAndNavigate` with a `preview` tab) pushed `/p/3000`
 * onto the app's tab strip, which reads as "you have left the session"; the
 * user then has to find their way back to keep talking to the agent.
 *
 * The two panel modes host that preview differently, so this is the one place
 * that knows both:
 *
 *   - **Easy** (the default, and currently the only one `ActionPanel` renders)
 *     has no tab strip. `EasyPanel` opens the port as an `AppPreview` DETAIL
 *     layer — the same thing a Preview-card row opens. Reached through the
 *     nonce'd `appOpenBySession` request channel, exactly like chat file-path
 *     clicks reach it through `fileOpenBySession`.
 *   - **Advanced** has the `browser` view, hosting the real `BrowserPanel`,
 *     which is driven by tab-store metadata. That's the route
 *     `LocalhostLinkInterceptor` already takes for bare anchors.
 *
 * Both are requested unconditionally-but-cheaply: the Easy request is a store
 * write the Advanced panel never subscribes to, and the Advanced view flip is
 * skipped in Easy mode so it can't quietly move where a later mode switch
 * lands the user.
 */

import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  getActivePanelSessionId,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

export interface PortPanelTarget {
  port: number;
  path: string;
  /** Browser-reachable proxied url — what Advanced's `BrowserPanel` iframes. */
  proxyUrl: string;
  /** `http://localhost:PORT/path` — what Easy's `AppPreview` navigates (it
   *  proxies the url itself, so it must be handed the internal one). */
  internalUrl: string;
  /** Header label. Defaults to `localhost:PORT`. */
  title?: string;
}

/**
 * Open `target` in the active session's panel and reveal the panel.
 *
 * Returns `false` when there is no active session layout to host it — off a
 * session page (dashboard, settings) there is no panel at all, and the caller
 * is expected to fall back to whatever it did before. Same escape hatch
 * `LocalhostLinkInterceptor` takes when `getActivePanelSessionId()` is null.
 */
export function openPortInSessionPanel(target: PortPanelTarget): boolean {
  const sessionId = getActivePanelSessionId();
  if (!sessionId) return false;

  const title = target.title ?? `localhost:${target.port}`;

  useSessionBrowserStore.getState().requestAppOpen(sessionId, target.internalUrl, title);

  // Advanced only. Flipping `viewBySession` in Easy mode would write a view the
  // user can't see and never chose — it would surface on their next mode
  // switch as an unexplained jump to the browser tab.
  if ((useUserPreferencesStore.getState().preferences.panelMode ?? 'easy') === 'advanced') {
    useTabStore.getState().openTab({
      id: sessionPreviewTabId(sessionId),
      title,
      type: 'preview',
      // The session's own route: this tab is panel content, not a destination,
      // so it must never move the address bar off the session.
      href: window.location.pathname,
      metadata: enrichPreviewMetadata({
        url: target.proxyUrl,
        port: target.port,
        originalUrl: target.internalUrl,
        path: target.path,
      }),
    });
    useSessionBrowserStore.getState().setView(sessionId, 'browser');
  }

  useKortixComputerStore.getState().setIsSidePanelOpen(true);
  return true;
}
