import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { loadClientCatalog } from './client-catalog';
import { locales } from './config';
import en from '../../translations/en.json';

test('bundled catalogs load for every locale without an HTTP dependency', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new Window() });
  const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  try {
    for (const locale of locales) {
      const first = loadClientCatalog(locale);
      expect(loadClientCatalog(locale)).toBe(first);
      const messages = await first;
      expect(Object.keys(messages).length).toBeGreaterThan(0);
      expect(await loadClientCatalog(locale)).toBe(messages);
      if (locale === 'en') expect(messages).toEqual(en);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
