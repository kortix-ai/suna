import { describe, expect, test } from 'bun:test';

import { pixelMarkShape } from './pixel-mark';

// One golden set for every host: web (`@kortix/ui` `pixelMark`) and mobile
// paint these exact paths. A change here redraws every agent on every surface.
describe('pixelMarkShape', () => {
  test('golden 7 × 7 marks', () => {
    const golden = {
      kortix: 'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h5v1h-5zM0 3h3v1h-3zM4 3h3v1h-3zM0 4h7v1h-7zM1 5h2v1h-2zM4 5h2v1h-2zM1 6h2v1h-2zM4 6h2v1h-2z',
      'harness-reflector':
        'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM0 3h7v1h-7zM2 4h1v1h-1zM4 4h1v1h-1zM1 5h5v1h-5zM1 6h1v1h-1zM3 6h1v1h-1zM5 6h1v1h-1z',
      scout: 'M1 1h1v1h-1zM3 1h1v1h-1zM5 1h1v1h-1zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM1 3h5v1h-5zM0 4h3v1h-3zM4 4h3v1h-3zM2 5h3v1h-3zM2 6h3v1h-3z',
      reviewer: 'M3 0h1v1h-1zM3 1h1v1h-1zM0 2h3v1h-3zM4 2h3v1h-3zM1 3h5v1h-5zM2 4h3v1h-3zM2 5h3v1h-3zM1 6h2v1h-2zM4 6h2v1h-2z',
    };
    for (const [slug, path] of Object.entries(golden)) {
      expect(pixelMarkShape(slug)).toMatchObject({ path, ditherPath: '', width: 7, height: 7 });
    }
  });

  test('golden My Kortix mark: the 12 × 10 Kortix symbol, solid and dithered cells', () => {
    expect(pixelMarkShape('mykortix')).toMatchObject({
      path: 'M0 0h2v1h-2zM5 0h2v1h-2zM10 0h2v1h-2zM0 1h2v1h-2zM5 1h2v1h-2zM10 1h2v1h-2zM1 2h1v1h-1zM5 2h2v1h-2zM10 2h1v1h-1zM1 3h2v1h-2zM5 3h2v1h-2zM9 3h2v1h-2zM2 4h8v1h-8zM2 5h8v1h-8zM1 6h2v1h-2zM5 6h2v1h-2zM9 6h2v1h-2zM1 7h1v1h-1zM5 7h2v1h-2zM10 7h1v1h-1zM0 8h2v1h-2zM5 8h2v1h-2zM10 8h2v1h-2zM0 9h2v1h-2zM5 9h2v1h-2zM10 9h2v1h-2z',
      ditherPath: 'M0 2h1v1h-1zM2 2h1v1h-1zM9 2h1v1h-1zM11 2h1v1h-1zM3 3h1v1h-1zM8 3h1v1h-1zM3 6h1v1h-1zM8 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM9 7h1v1h-1zM11 7h1v1h-1z',
      width: 12,
      height: 10,
    });
  });
});
