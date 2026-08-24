import type { ServicePreviewState } from '@/features/session/tool/shared/infrastructure';
import { describe, expect, test } from 'bun:test';
import {
  createSharedPreviewStore,
  publishSharedPreview,
  removeSharedPreview,
} from './shared-preview';

const preview = (refreshKey: number, previewUrl = 'https://preview.test/authenticated') =>
  ({ refreshKey, previewUrl }) as ServicePreviewState;

describe('shared preview ownership', () => {
  test('keeps one owner for duplicate URLs and promotes the next owner', () => {
    const store = createSharedPreviewStore();
    const first = Symbol('first');
    const second = Symbol('second');

    publishSharedPreview(store, 'https://preview.test', first, preview(0));
    publishSharedPreview(store, 'https://preview.test', second, preview(0));

    expect(store.previews.get('https://preview.test')?.keys().next().value).toBe(first);
    expect(store.previews.get('https://preview.test')?.size).toBe(2);

    removeSharedPreview(store, 'https://preview.test', first);

    expect(store.previews.get('https://preview.test')?.keys().next().value).toBe(second);
    expect(store.frameUrls.get('https://preview.test')).toBe('https://preview.test/authenticated');
    expect(store.refreshVersions.get('https://preview.test')).toBe(0);
  });

  test('updates one owner without changing ownership order', () => {
    const store = createSharedPreviewStore();
    const first = Symbol('first');
    const second = Symbol('second');
    const refreshed = preview(1);

    publishSharedPreview(store, 'https://preview.test', first, preview(0));
    publishSharedPreview(store, 'https://preview.test', second, preview(0));
    publishSharedPreview(store, 'https://preview.test', first, refreshed);

    expect(store.previews.get('https://preview.test')?.keys().next().value).toBe(first);
    expect(store.previews.get('https://preview.test')?.get(first)).toBe(refreshed);
  });
});
