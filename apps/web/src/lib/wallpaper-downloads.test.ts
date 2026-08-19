import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { WALLPAPER_DOWNLOADS } from './wallpaper-downloads';
import { WALLPAPERS } from './wallpapers';

const PUBLIC_DIR = join(import.meta.dir, '../../public');

describe('wallpaper downloads manifest', () => {
  test('every download and preview resolves to a real file of the stated size', () => {
    expect(WALLPAPER_DOWNLOADS.length).toBeGreaterThan(0);

    for (const wallpaper of WALLPAPER_DOWNLOADS) {
      expect(statSync(join(PUBLIC_DIR, wallpaper.preview)).size).toBeGreaterThan(0);
      expect(wallpaper.files.length).toBeGreaterThan(0);

      for (const file of wallpaper.files) {
        expect(file.href).toBe(`/wallpapers/downloads/${file.file}`);
        expect(statSync(join(PUBLIC_DIR, file.href)).size).toBe(file.bytes);
        // The filename carries the resolution the page advertises.
        expect(file.file).toContain(`${file.width}x${file.height}`);
      }
    }
  });

  test('offers every wallpaper a Kortix home can render, in both themes', () => {
    const renderable = WALLPAPERS.filter((w) => w.type !== 'none').map((w) => w.id);

    for (const id of renderable) {
      for (const theme of ['light', 'dark'] as const) {
        const hit = WALLPAPER_DOWNLOADS.find(
          (w) => w.group === 'product' && w.id === id && w.theme === theme,
        );
        expect(hit).toBeDefined();
      }
    }

    // `blank` paints nothing, so there is nothing to download.
    expect(WALLPAPER_DOWNLOADS.some((w) => w.id === 'blank')).toBe(false);
  });

  test('ships both brand families on both fields, across the whole size ladder', () => {
    for (const id of ['symbol', 'logo']) {
      for (const theme of ['light', 'dark'] as const) {
        const hit = WALLPAPER_DOWNLOADS.find(
          (w) => w.group === 'mark' && w.id === id && w.theme === theme,
        );
        expect(hit).toBeDefined();
        expect(hit?.files.map((f) => f.label)).toEqual(['5K', '4K', '1440p', 'Phone']);
      }
    }
  });

  test('ships a desktop and a phone file for every wallpaper', () => {
    for (const wallpaper of WALLPAPER_DOWNLOADS) {
      const labels = wallpaper.files.map((f) => f.label);
      expect(labels).toContain('5K');
      expect(labels).toContain('Phone');
      expect(wallpaper.files.find((f) => f.label === '5K')).toMatchObject({
        width: 5120,
        height: 2880,
      });
      expect(wallpaper.files.find((f) => f.label === 'Phone')).toMatchObject({
        width: 1290,
        height: 2796,
      });
    }
  });
});
