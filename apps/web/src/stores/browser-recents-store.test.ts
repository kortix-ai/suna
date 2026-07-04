import { beforeEach, describe, expect, test } from 'bun:test';

import {
  normalizeRecentUrl,
  recentDisplayLabel,
  useBrowserRecentsStore,
} from './browser-recents-store';

beforeEach(() => {
  useBrowserRecentsStore.getState().clearRecents();
});

describe('normalizeRecentUrl', () => {
  test('strips trailing slashes', () => {
    expect(normalizeRecentUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeRecentUrl('http://localhost:3000/debug/tools/')).toBe(
      'http://localhost:3000/debug/tools',
    );
  });

  test('keeps paths and query fragments intact', () => {
    expect(normalizeRecentUrl('http://localhost:3000/design-system#comp-kbd')).toBe(
      'http://localhost:3000/design-system#comp-kbd',
    );
  });

  test('rejects values without an http(s) scheme and host', () => {
    expect(normalizeRecentUrl('')).toBe('');
    expect(normalizeRecentUrl('localhost:3000')).toBe('');
    expect(normalizeRecentUrl('http:///')).toBe('');
    expect(normalizeRecentUrl('ftp://example.com')).toBe('');
  });
});

describe('recentDisplayLabel', () => {
  test('drops the scheme', () => {
    expect(recentDisplayLabel('http://localhost:13000/game-of-life')).toBe(
      'localhost:13000/game-of-life',
    );
    expect(recentDisplayLabel('https://example.com')).toBe('example.com');
  });
});

describe('useBrowserRecentsStore', () => {
  test('addRecent stores the normalized URL at the front', () => {
    const store = useBrowserRecentsStore.getState();
    store.addRecent('http://localhost:3000/');
    store.addRecent('http://localhost:13000/game-of-life');
    const urls = useBrowserRecentsStore.getState().recents.map((r) => r.url);
    expect(urls).toEqual(['http://localhost:13000/game-of-life', 'http://localhost:3000']);
  });

  test('revisiting a URL dedupes and moves it to the front', () => {
    const store = useBrowserRecentsStore.getState();
    store.addRecent('http://localhost:3000');
    store.addRecent('http://localhost:13000');
    store.addRecent('http://localhost:3000/');
    const urls = useBrowserRecentsStore.getState().recents.map((r) => r.url);
    expect(urls).toEqual(['http://localhost:3000', 'http://localhost:13000']);
  });

  test('ignores invalid input', () => {
    useBrowserRecentsStore.getState().addRecent('not a url');
    expect(useBrowserRecentsStore.getState().recents).toEqual([]);
  });

  test('caps the list at 8 entries', () => {
    const store = useBrowserRecentsStore.getState();
    for (let port = 3000; port < 3012; port++) {
      store.addRecent(`http://localhost:${port}`);
    }
    const { recents } = useBrowserRecentsStore.getState();
    expect(recents).toHaveLength(8);
    expect(recents[0].url).toBe('http://localhost:3011');
  });

  test('removeRecent drops the matching entry', () => {
    const store = useBrowserRecentsStore.getState();
    store.addRecent('http://localhost:3000');
    store.addRecent('http://localhost:13000');
    store.removeRecent('http://localhost:3000/');
    const urls = useBrowserRecentsStore.getState().recents.map((r) => r.url);
    expect(urls).toEqual(['http://localhost:13000']);
  });
});
