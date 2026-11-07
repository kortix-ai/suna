import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { CHUNK_BOOT_RECOVERY_SCRIPT } from './chunk-boot-recovery';
import { reloadForChunkLoadError } from '@kortix/ui/internal/lib/chunk-load-recovery';

/**
 * Runs the shipped inline script with the page's globals in scope, as the
 * document head does. happy-dom 20+ has no `window.eval`, and its script
 * context under Bun has no JavaScript builtins (`String` is undefined there),
 * so the text runs in this realm. A name the page window defines (`window`,
 * `location`, `sessionStorage`) resolves on the page; a builtin the page
 * leaves undefined (`Date`, `Number`) resolves in this realm.
 */
function runInlineScript(window: Window) {
  const page = window as unknown as Record<PropertyKey, unknown>;
  const scope = new Proxy(page, {
    has: (target, key) => key in target && target[key] !== undefined,
    get: (target, key) => target[key],
  });
  new Function('page', `with (page) { ${CHUNK_BOOT_RECOVERY_SCRIPT} }`)(scope);
}

function browser() {
  const window = new Window({ url: 'http://localhost:13000/settings/profile?accountTab=settings' });
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  // The inline script runs in <head>, while the document is still loading.
  let readyState = 'loading';
  Object.defineProperty(window.document, 'readyState', { configurable: true, get: () => readyState });
  let online = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  runInlineScript(window);
  return {
    window,
    reload,
    finishLoading() {
      readyState = 'complete';
    },
    setOnline(value: boolean) {
      online = value;
    },
  };
}

function failChunk(window: Window, src: string) {
  const script = window.document.createElement('script');
  script.src = src;
  window.document.head.append(script);
  script.dispatchEvent(new window.Event('error'));
}

test('a failed bootstrap chunk reloads before React mounts, once across documents', () => {
  const { window, reload } = browser();
  const script = window.document.createElement('script');
  script.src = '/_next/static/chunks/runtime.js';
  window.document.head.append(script);
  script.dispatchEvent(new window.Event('error'));
  expect(reload).toHaveBeenCalledTimes(1);
  // Reinstall the shipped inline script as on the next document, retaining tab storage.
  runInlineScript(window);
  script.dispatchEvent(new window.Event('error'));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadForChunkLoadError(new Error('Loading chunk 42 failed.'), {
    storage: window.sessionStorage,
    reload: () => window.location.reload(),
  })).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.location.pathname + window.location.search).toBe('/settings/profile?accountTab=settings');
  window.close();
});

test('unrelated resource failures and runtime exceptions do not reload', () => {
  const { window, reload } = browser();
  for (const src of ['/analytics.js', 'https://external.example/_next/static/chunks/a.js']) {
    const script = window.document.createElement('script');
    script.src = src;
    window.document.head.append(script);
    script.dispatchEvent(new window.Event('error'));
  }
  const image = window.document.createElement('img');
  image.src = '/_next/static/chunks/image.js';
  window.document.body.append(image);
  image.dispatchEvent(new window.Event('error'));
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'application bug' }));
  expect(reload).not.toHaveBeenCalled();
  window.close();
});

test('the immutable chunk path the production host serves recovers too', () => {
  const { window, reload } = browser();
  failChunk(window, '/_next/static/immutable/chunks/0abc123.js');
  expect(reload).toHaveBeenCalledTimes(1);
  window.close();
});

test('a chunk that fails after the document loaded is left to the React boundaries', () => {
  // A hover prefetch or a lazy import after boot: the boundary that needs the
  // chunk reloads once (reloadForChunkLoadError). This script must not reload
  // the page for a chunk nobody is waiting for.
  const { window, reload, finishLoading } = browser();
  finishLoading();
  failChunk(window, '/_next/static/chunks/route.js');
  failChunk(window, '/_next/static/immutable/chunks/route.js');
  expect(reload).not.toHaveBeenCalled();
  window.close();
});

test('offline, a boot chunk failure waits for the network instead of reloading into an error page', () => {
  const { window, reload, setOnline } = browser();
  setOnline(false);
  failChunk(window, '/_next/static/chunks/runtime.js');
  expect(reload).not.toHaveBeenCalled();
  setOnline(true);
  window.dispatchEvent(new window.Event('online'));
  expect(reload).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new window.Event('online'));
  expect(reload).toHaveBeenCalledTimes(1);
  window.close();
});

test('blocked session storage never permits an unguarded reload', () => {
  const { window, reload } = browser();
  Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
  const script = window.document.createElement('script');
  script.src = '/_next/static/chunks/runtime.js';
  window.document.head.append(script);
  script.dispatchEvent(new window.Event('error'));
  expect(reload).not.toHaveBeenCalled();
  window.close();
});
