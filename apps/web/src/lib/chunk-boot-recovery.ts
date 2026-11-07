import { CHUNK_RELOAD_WINDOW_MS } from '@kortix/ui/internal/lib/chunk-load-recovery';

/**
 * Inline in the document head: React boundaries cannot recover a chunk that prevents hydration.
 *
 * It acts only while the document loads. Every chunk hydration needs is a
 * script in the server HTML, so it settles before `readyState` is `complete`.
 * A chunk that fails later (a hover prefetch, a lazy import, the next route)
 * belongs to the code that waits for it: the error boundaries and
 * `withStaleChunkRecovery` reload once through `reloadForChunkLoadError`. A
 * reload from here for such a chunk reloaded the page with no click at all,
 * for a chunk nothing was waiting for.
 *
 * Offline, a reload lands on the browser's offline page, so a failure then
 * waits for the `online` event and reloads once the network is back.
 *
 * The path covers both chunk locations: `/_next/static/chunks/` (the
 * standalone server on ECS) and `/_next/static/immutable/chunks/` (the
 * immutable-assets adapter on Vercel).
 */
export const CHUNK_BOOT_RECOVERY_SCRIPT = `
(function () {
  function reloadOnce() {
    try {
      var now = Date.now();
      var mark = sessionStorage.getItem('kortix:chunk-reload-at');
      if (mark !== null && Number.isFinite(Number(mark)) && now - Number(mark) < ${CHUNK_RELOAD_WINDOW_MS}) return;
      sessionStorage.setItem('kortix:chunk-reload-at', String(now));
    } catch (_) {
      return;
    }
    location.reload();
  }
  var waitingForNetwork = false;
  window.addEventListener('error', function (event) {
    if (document.readyState === 'complete') return;
    var script = event.target;
    if (!(script instanceof HTMLScriptElement) || !script.src) return;
    var url = new URL(script.src, location.href);
    if (url.origin !== location.origin || !/^\\/_next\\/static\\/(?:immutable\\/)?chunks\\/.+\\.js$/.test(url.pathname)) return;
    if (navigator.onLine === false) {
      if (waitingForNetwork) return;
      waitingForNetwork = true;
      window.addEventListener('online', reloadOnce, { once: true });
      return;
    }
    reloadOnce();
  }, true);
})();`;
