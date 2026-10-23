import { describe, expect, test } from 'bun:test';

import { passesPixelMarkGate, pixelMark } from './pixel-mark';

describe('pixelMark', () => {
  test('golden marks: a change here redraws every agent in every project', () => {
    expect(pixelMark('kortix')).toMatchObject({
      path: 'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h5v1h-5zM0 3h3v1h-3zM4 3h3v1h-3zM0 4h7v1h-7zM1 5h2v1h-2zM4 5h2v1h-2zM1 6h2v1h-2zM4 6h2v1h-2z',
      tone: { name: 'brand' },
    });
    expect(pixelMark('harness-reflector')).toMatchObject({
      path: 'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM0 3h7v1h-7zM2 4h1v1h-1zM4 4h1v1h-1zM1 5h5v1h-5zM1 6h1v1h-1zM3 6h1v1h-1zM5 6h1v1h-1z',
      tone: { name: 'sea' },
    });
  });

  test('every mark is mirrored and passes the gate', () => {
    const paths = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { grid, path } = pixelMark(`agent-${i}`);
      expect(passesPixelMarkGate(grid)).toBe(true);
      for (const row of grid) expect(row).toEqual([...row].reverse());
      paths.add(path);
    }
    expect(paths.size).toBeGreaterThan(1940);
  });
});
