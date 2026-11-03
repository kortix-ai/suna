import { describe, expect, test } from 'bun:test';

import { greyThumb, MOVED_MEAN, THUMB_HEIGHT, THUMB_WIDTH, thumbMoved } from './screen-share';

const PIXELS = THUMB_WIDTH * THUMB_HEIGHT;
/** An RGBA thumbnail of one colour. */
const solid = (r: number, g: number, b: number) => {
  const rgba = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i++) rgba.set([r, g, b, 255], 4 * i);
  return rgba;
};

describe('greyThumb', () => {
  test('each pixel is the mean of its red, green and blue, rounded down; alpha is ignored', () => {
    const grey = greyThumb(solid(10, 20, 31));
    expect(grey.length).toBe(PIXELS);
    expect(grey[0]).toBe(20);
    expect(grey[PIXELS - 1]).toBe(20);
  });
});

describe('thumbMoved', () => {
  test('the first frame counts as changed', () => {
    expect(thumbMoved(undefined, greyThumb(solid(0, 0, 0)))).toBe(true);
  });

  test('a picture whose mean pixel difference reaches the threshold changed', () => {
    const last = greyThumb(solid(100, 100, 100));
    expect(thumbMoved(last, greyThumb(solid(100 + MOVED_MEAN, 100 + MOVED_MEAN, 100 + MOVED_MEAN)))).toBe(true);
    expect(thumbMoved(last, greyThumb(solid(100 - MOVED_MEAN, 100 - MOVED_MEAN, 100 - MOVED_MEAN)))).toBe(true);
  });

  test('noise under the threshold, or the same picture, did not change', () => {
    const last = greyThumb(solid(100, 100, 100));
    const step = MOVED_MEAN - 1;
    expect(thumbMoved(last, greyThumb(solid(100 + step, 100 + step, 100 + step)))).toBe(false);
    expect(thumbMoved(last, last)).toBe(false);
  });

  test('a change in a small part of the screen counts by its share of the pixels', () => {
    const last = greyThumb(solid(0, 0, 0));
    const next = new Uint8Array(last);
    // 58 of 576 pixels go from black to white: a mean difference of 25.7.
    for (let i = 0; i < 58; i++) next[i] = 255;
    expect(thumbMoved(last, next)).toBe(true);
    const speck = new Uint8Array(last);
    // Five pixels: a mean difference of 2.2.
    for (let i = 0; i < 5; i++) speck[i] = 255;
    expect(thumbMoved(last, speck)).toBe(false);
  });
});
