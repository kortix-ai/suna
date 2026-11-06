import { describe, expect, test } from 'bun:test';
import { passesPixelMarkGate, pixelMark } from './agent-pixel-mark';

describe('agent pixel mark (same algorithm as web)', () => {
  test('one slug, one mark; a different slug, a different mark; every mark passes the gate', () => {
    expect(pixelMark('scout').path).toBe(pixelMark('scout').path);
    expect(pixelMark('scout').path).not.toBe(pixelMark('reviewer').path);
    for (const slug of ['scout', 'reviewer', 'harness-reflector', 'jay', 'scribe']) expect(passesPixelMarkGate(pixelMark(slug).grid)).toBe(true);
  });

  test('My Kortix wears the Kortix symbol, a 12 × 10 grid', () => {
    const mark = pixelMark('mykortix');
    expect([mark.width, mark.height]).toEqual([12, 10]);
  });
});
