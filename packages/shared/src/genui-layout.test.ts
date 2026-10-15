import { describe, expect, test } from 'bun:test';

import { cardImageShape, cardListLayout, masonryColumns } from './genui-layout';

describe('genui layout', () => {
  test('masonry puts each image in the shorter column, so a tall image never leaves a hole beside a short one', () => {
    // The headphones answer: a short landscape shot, a tall portrait, then a short one. CSS columns put the
    // first alone on the left and stacked the other two on the right; shortest-column fills the left.
    expect(masonryColumns([0.87, 1.31, 0.53])).toEqual([[0, 2], [1]]);
    expect(masonryColumns([0.75, 0.75, 0.75, 0.75])).toEqual([[0, 2], [1, 3]]);
    expect(masonryColumns([2, 0.5, 0.5, 0.5])).toEqual([[0], [1, 2, 3]]);
  });
  test('a card image keeps its own shape: a logo or near-square shot is an inset square, a photo keeps its ratio, extremes show whole', () => {
    expect(cardImageShape(0, 0)).toEqual({ ratio: 3 / 4, fit: 'cover', inset: false });
    expect(cardImageShape(800, 600)).toEqual({ ratio: 3 / 4, fit: 'cover', inset: false });
    expect(cardImageShape(1280, 1441)).toEqual({ ratio: 1, fit: 'contain', inset: true });
    expect(cardImageShape(160, 90)).toEqual({ ratio: 1, fit: 'contain', inset: true });
    expect(cardImageShape(1200, 300)).toEqual({ ratio: 9 / 16, fit: 'contain', inset: false });
    expect(cardImageShape(600, 1200)).toEqual({ ratio: 4 / 3, fit: 'contain', inset: false });
    expect(cardImageShape(600, 780)).toEqual({ ratio: 1.3, fit: 'cover', inset: false });
    // Just past a limit (900x500 is a hair wider than 16:9): fill the tile, a 1% crop beats two bars.
    expect(cardImageShape(900, 500)).toEqual({ ratio: 9 / 16, fit: 'cover', inset: false });
  });
  test('the layout hint wins; without one, a grid only when most loaded images are photos', () => {
    const photo = cardImageShape(1920, 1080);
    const logo = cardImageShape(1280, 1280);
    expect(cardListLayout('list', [photo, photo])).toBe('list');
    expect(cardListLayout('grid', [logo, logo])).toBe('grid');
    expect(cardListLayout(undefined, [])).toBe('list');
    expect(cardListLayout(undefined, [photo, photo, logo])).toBe('grid');
    expect(cardListLayout(undefined, [photo, logo])).toBe('list');
    expect(cardListLayout(undefined, [logo, logo, logo])).toBe('list');
  });
});
