import { CHUNK_RELOAD_WINDOW_MS } from './chunk-load-recovery';

/** Inline in the document head: React boundaries cannot recover a chunk that prevents hydration. */
export const CHUNK_BOOT_RECOVERY_SCRIPT = `
(function () {
  window.addEventListener('error', function (event) {
    var script = event.target;
    if (!(script instanceof HTMLScriptElement) || !script.src) return;
    var url = new URL(script.src, location.href);
    if (url.origin !== location.origin || !/^\\/_next\\/static\\/chunks\\/.+\\.js$/.test(url.pathname)) return;
    try {
      var now = Date.now();
      var mark = sessionStorage.getItem('kortix:chunk-reload-at');
      if (mark !== null && Number.isFinite(Number(mark)) && now - Number(mark) < ${CHUNK_RELOAD_WINDOW_MS}) return;
      sessionStorage.setItem('kortix:chunk-reload-at', String(now));
    } catch (_) {
      return;
    }
    location.reload();
  }, true);
})();`;
