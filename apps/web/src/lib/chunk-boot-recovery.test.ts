import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { CHUNK_BOOT_RECOVERY_SCRIPT } from './chunk-boot-recovery';
import { reloadForChunkLoadError } from '@kortix/ui/internal/lib/chunk-load-recovery';

function browser() {
  const window = new Window({ url: 'http://localhost:13000/settings/profile?accountTab=settings' });
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  window.eval(CHUNK_BOOT_RECOVERY_SCRIPT);
  return { window, reload };
}

test('a failed bootstrap chunk reloads before React mounts, once across documents', () => {
  const { window, reload } = browser();
  const script = window.document.createElement('script');
  script.src = '/_next/static/chunks/runtime.js';
  window.document.head.append(script);
  script.dispatchEvent(new window.Event('error'));
  expect(reload).toHaveBeenCalledTimes(1);
  // Reinstall the shipped inline script as on the next document, retaining tab storage.
  window.eval(CHUNK_BOOT_RECOVERY_SCRIPT);
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
