import { describe, expect, test } from 'bun:test';

import { DEFAULT_WALLPAPER_ID, WALLPAPERS, getWallpaperById } from './wallpapers';

describe('wallpapers', () => {
  test('Dither is the default wallpaper', () => {
    expect(DEFAULT_WALLPAPER_ID).toBe('dither');
  });

  test('Dither leads the picker order', () => {
    expect(WALLPAPERS[0]?.id).toBe('dither');
  });

  test('the default id resolves to a real wallpaper', () => {
    const defaultWallpaper = WALLPAPERS.find((w) => w.id === DEFAULT_WALLPAPER_ID);
    expect(defaultWallpaper).toBeDefined();
    expect(getWallpaperById(DEFAULT_WALLPAPER_ID).id).toBe('dither');
  });

  test('every wallpaper id is unique', () => {
    const ids = WALLPAPERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an unknown id falls back to the first (default) wallpaper', () => {
    expect(getWallpaperById('does-not-exist').id).toBe(WALLPAPERS[0]!.id);
  });
});
