import { expect, test } from 'bun:test';

import * as root from '../../index';
import { createImageCache } from './image-cache';

const SHA = 'a'.repeat(64);

test('the root barrel exports the image cache', () => {
  expect(root.createImageCache).toBe(createImageCache);
});

test('an image stored by path and sha256 is found by either, and a second path links to the same entry', () => {
  const disposed: string[] = [];
  const cache = createImageCache<string>({ maxEntries: 4, dispose: (url) => disposed.push(url) });
  const entry = cache.put({ path: 'p|output/a.png', sha256: SHA }, 'blob:1', 10);
  expect(cache.get({ path: 'p|output/a.png' })).toBe(entry);
  expect(cache.get({ sha256: SHA })).toBe(entry);
  // The same bytes at another path (a Drive copy): the first value wins, the new one is disposed.
  expect(cache.put({ path: 'p|drives/a.png', sha256: SHA }, 'blob:2', 10)).toBe(entry);
  expect(disposed).toEqual(['blob:2']);
  expect(cache.get({ path: 'p|drives/a.png' })).toBe(entry);
  // A sha256 lookup wins over a path that names other bytes.
  expect(cache.get({ path: 'p|other.png', sha256: SHA })).toBe(entry);
  expect(cache.get({ path: 'p|other.png' })).toBeUndefined();
  expect(cache.get({})).toBeUndefined();
});

test('the least recently used image that nothing holds is evicted and disposed, by count and by bytes', () => {
  const disposed: string[] = [];
  const cache = createImageCache<string>({ maxEntries: 2, maxBytes: 100, dispose: (url) => disposed.push(url) });
  const a = cache.put({ path: 'a' }, 'url-a', 10);
  const releaseA = cache.retain(a);
  cache.put({ path: 'b' }, 'url-b', 10);
  cache.put({ path: 'c' }, 'url-c', 10);
  // `a` is held, so `b` goes.
  expect(disposed).toEqual(['url-b']);
  expect(cache.get({ path: 'a' })?.value).toBe('url-a');
  releaseA();
  // Released, `a` is the oldest and goes once the cache is over its bound.
  cache.put({ path: 'd' }, 'url-d', 10);
  expect(disposed).toEqual(['url-b', 'url-a']);
  // A 95-byte image pushes the total over 100 bytes: the older `c` goes.
  cache.put({ path: 'e' }, 'url-e', 95);
  expect(disposed).toContain('url-c');
  expect(cache.get({ path: 'e' })?.value).toBe('url-e');
});

test('a forgotten path drops its entry; a held entry is disposed only on its last release', () => {
  const disposed: string[] = [];
  const cache = createImageCache<string>({ maxEntries: 4, dispose: (url) => disposed.push(url) });
  const entry = cache.put({ path: 'a', sha256: SHA }, 'url-a', 1);
  const release = cache.retain(entry);
  cache.forget('a');
  expect(cache.get({ path: 'a' })).toBeUndefined();
  expect(cache.get({ sha256: SHA })).toBeUndefined();
  expect(disposed).toEqual([]);
  release();
  release();
  expect(disposed).toEqual(['url-a']);
});

test('listeners hear every change and stop on unsubscribe; a natural size is kept on the entry', () => {
  const cache = createImageCache<string>({ maxEntries: 4 });
  let heard = 0;
  const stop = cache.subscribe(() => heard++);
  const entry = cache.put({ path: 'a' }, 'url-a');
  cache.setSize(entry, 1254, 836);
  expect(cache.get({ path: 'a' })).toMatchObject({ width: 1254, height: 836 });
  cache.link('b', entry);
  expect(cache.get({ path: 'b' })).toBe(entry);
  stop();
  cache.forget('a');
  expect(heard).toBe(3);
});

test('a lookup with a sha256 never returns the path entry of other bytes', () => {
  const cache = createImageCache<string>({ maxEntries: 4 });
  const OTHER = 'b'.repeat(64);
  cache.put({ path: 'p|plot.png', sha256: SHA }, 'url-old');
  // The path now names new bytes: the old entry is not them.
  expect(cache.get({ path: 'p|plot.png', sha256: OTHER })).toBeUndefined();
  // A path entry stored without a digest is not a match for one either.
  cache.put({ path: 'p|chart.png' }, 'url-chart');
  expect(cache.get({ path: 'p|chart.png', sha256: OTHER })).toBeUndefined();
  // Without a digest, the path is the key.
  expect(cache.get({ path: 'p|chart.png' })?.value).toBe('url-chart');
});

test('clear drops and disposes every entry nothing holds; a held one goes on its last release', () => {
  const disposed: string[] = [];
  const cache = createImageCache<string>({ maxEntries: 4, dispose: (url) => disposed.push(url) });
  const held = cache.put({ path: 'a', sha256: SHA }, 'url-a');
  const release = cache.retain(held);
  cache.put({ path: 'b' }, 'url-b');
  let heard = 0;
  cache.subscribe(() => heard++);
  cache.clear();
  expect(cache.get({ path: 'a' })).toBeUndefined();
  expect(cache.get({ sha256: SHA })).toBeUndefined();
  expect(cache.get({ path: 'b' })).toBeUndefined();
  expect(disposed).toEqual(['url-b']);
  expect(heard).toBe(1);
  release();
  expect(disposed).toEqual(['url-b', 'url-a']);
});

