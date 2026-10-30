import { describe, expect, test } from 'bun:test';

import { createSelectionStore, decodeDragPaths, encodeDragPaths } from './drive-selection';

describe('a move drag carries one path or the whole selection', () => {
  test('one path stays a plain path (the file tree reads it as one)', () => {
    expect(encodeDragPaths(['a/b.md'])).toBe('a/b.md');
    expect(decodeDragPaths('a/b.md')).toEqual(['a/b.md']);
  });

  test('several round-trip', () => {
    const paths = ['qq', 'notes/a.md', 'b c.png'];
    expect(decodeDragPaths(encodeDragPaths(paths))).toEqual(paths);
  });

  test('a folder named like JSON is still one path', () => {
    expect(decodeDragPaths('[draft]')).toEqual(['[draft]']);
  });

  test('nothing carried is nothing moved', () => {
    expect(decodeDragPaths('')).toEqual([]);
  });
});

describe('the selection store notifies only on a real change', () => {
  test('a drag frame that hits the same items re-renders nobody', () => {
    const store = createSelectionStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(new Set(['a', 'b']));
    store.set(new Set(['b', 'a'])); // same items, new Set: no notify
    expect(calls).toBe(1);
    store.set(new Set(['a']));
    expect(calls).toBe(2);
  });

  test('select mode stays on with nothing selected until cleared', () => {
    const store = createSelectionStore();
    expect(store.mode()).toBe(false);
    store.set(new Set(), true);
    expect(store.mode()).toBe(true);
    store.clear();
    expect(store.mode()).toBe(false);
  });
});
