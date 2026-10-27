/**
 * The live preview on an App card (KRTX-2183) — the pure pieces, so `bun test`
 * covers them. The card itself is `components/pages/AppsPage.tsx`.
 *
 * Web frames the same App the same way (`apps/web/src/features/apps/app-preview.tsx`):
 * a short-lived access session URL, rendered at a desktop width and scaled
 * down into a fixed-ratio tile that takes no input. The App model carries no
 * thumbnail, so the preview is always live.
 */

import type { App } from '@kortix/sdk';

import { appStatus } from './apps';

/** What a card shows in its preview region. Only `live` loads anything. */
export type AppPreviewState = 'live' | 'denied' | 'not-deployed' | 'suspended' | 'unavailable';

/** At most this many preview WebViews exist at once. */
export const PREVIEW_CONCURRENCY = 3;
/** A preview that has not loaded by then shows its fallback for the rest of the visit. */
export const PREVIEW_TIMEOUT_MS = 10_000;
/** The page lays out at this CSS width (a desktop breakpoint) and is scaled to the card. */
export const PREVIEW_VIEWPORT_WIDTH = 1024;
/** The preview region's width / height: 16:10, the top of the page. */
export const PREVIEW_ASPECT = 16 / 10;

/**
 * May this card load a live preview? The same gates web's card uses
 * (`preloadApps`, `cardPreviewApp`), checked before any request:
 * - `viewer_can_access === false`: never mint an access session (it is a 403).
 * - not deployed, or suspended: nothing serves the URL, so no request.
 * - no `preview` capability (the access-session route answers 409), the App
 *   hides its card preview (`display.preview: 'none'`), or it has no URL.
 */
export function appPreviewState(
  app: Pick<
    App,
    | 'viewer_can_access'
    | 'active_deployment_id'
    | 'desired_state'
    | 'hosting_type'
    | 'capabilities'
    | 'display'
    | 'external_url'
    | 'url'
  >,
): AppPreviewState {
  if (app.viewer_can_access === false) return 'denied';
  if (!app.external_url) {
    const status = appStatus(app);
    if (status === 'Not deployed') return 'not-deployed';
    if (status === 'Suspended') return 'suspended';
  }
  if (!app.capabilities?.includes('preview')) return 'unavailable';
  if (app.display?.preview === 'none') return 'unavailable';
  if (!app.url && !app.external_url) return 'unavailable';
  return 'live';
}

/**
 * The preview slots: cards ask for one while they are on screen and give it
 * back when they leave. The first `cap` askers, in asking order, hold one; a
 * later asker waits until an earlier one gives its slot back. A card that
 * already holds a slot never loses it to a newer asker.
 */
export function createPreviewSlots(cap: number = PREVIEW_CONCURRENCY) {
  let queue: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    want(id: string) {
      if (queue.includes(id)) return;
      queue = [...queue, id];
      notify();
    },
    drop(id: string) {
      if (!queue.includes(id)) return;
      queue = queue.filter((item) => item !== id);
      notify();
    },
    granted(id: string): boolean {
      const index = queue.indexOf(id);
      return index >= 0 && index < cap;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type PreviewSlots = ReturnType<typeof createPreviewSlots>;

/**
 * The preview follows the access-session redirects of its first load, then
 * stays on that page: a later top-frame navigation (a link, a script
 * redirect, a download) is refused. Subframes load freely. `isTopFrame` is
 * missing on some platforms; missing counts as the top frame.
 */
export function allowPreviewNavigation(loaded: boolean, isTopFrame: boolean | undefined): boolean {
  return !loaded || isTopFrame === false;
}

/**
 * Runs in the preview before the page's own scripts. It makes the page lay
 * out at `PREVIEW_VIEWPORT_WIDTH` (the WebView then scales it to the card:
 * WKWebView by the viewport rule, Android by `scalesPageToFit`), and it turns
 * every permission prompt and popup into a quiet refusal: camera,
 * microphone, location, notifications, `window.open`.
 */
export const PREVIEW_INJECTED_JS = `(function () {
  var content = 'width=${PREVIEW_VIEWPORT_WIDTH}';
  function fit() {
    var metas = document.querySelectorAll('meta[name="viewport"]');
    if (!metas.length) {
      var meta = document.createElement('meta');
      meta.name = 'viewport';
      (document.head || document.documentElement).appendChild(meta);
      metas = [meta];
    }
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', content);
  }
  try { fit(); document.addEventListener('DOMContentLoaded', fit); } catch (e) {}
  try {
    var refuse = function () { return Promise.reject(new Error('Not available in a preview')); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = refuse;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition = function (ok, fail) { if (fail) fail({ code: 1, message: 'denied' }); };
      navigator.geolocation.watchPosition = function (ok, fail) { if (fail) fail({ code: 1, message: 'denied' }); return 0; };
    }
    if (window.Notification) window.Notification.requestPermission = function () { return Promise.resolve('denied'); };
    window.open = function () { return null; };
  } catch (e) {}
})();
true;`;
