import { describe, expect, test } from 'bun:test';
import { imageMime } from './processing';

const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
// A real 2×2 PNG; JPEG and WebP by their magic bytes.
const PNG = hex('89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001049444154789c63f8cfc000440c100a001fee03fd8b5f14d40000000049454e44ae426082');

describe('imageMime: only real images go to the vision model', () => {
  test('PNG, JPEG and WebP are recognised by their bytes, whatever the file name says', () => {
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(hex('ffd8ffe000104a464946'))).toBe('image/jpeg');
    expect(imageMime(hex('524946462400000057454250565038'))).toBe('image/webp');
  });

  test('anything else (a placeholder, text, a truncated file) is not an image', () => {
    expect(imageMime(new TextEncoder().encode('not a jpeg at all'))).toBeNull();
    expect(imageMime(hex('ffd8'))).toBeNull();
    expect(imageMime(new Uint8Array())).toBeNull();
  });
});

import { retryTransient } from './processing';

describe('retryTransient: a busy or unavailable model is retried, a real refusal is not', () => {
  const answers = (...statuses: number[]) => {
    let i = 0;
    return async () => new Response('{}', { status: statuses[Math.min(i++, statuses.length - 1)]!, headers: statuses[i - 1] === 429 ? { 'retry-after': '1' } : {} });
  };
  test('429, then 503, then 200: three attempts, waits honour Retry-After, else back off', async () => {
    const waits: number[] = [];
    const res = await retryTransient(answers(429, 503, 200), async (ms) => void waits.push(ms));
    expect(res.status).toBe(200);
    expect(waits).toEqual([1000, 8000]);
  });
  test('a 400 is returned at once; three transient answers give up with the last one', async () => {
    const waits: number[] = [];
    expect((await retryTransient(answers(400), async (ms) => void waits.push(ms))).status).toBe(400);
    expect(waits).toEqual([]);
    expect((await retryTransient(answers(503, 503, 503, 200), async (ms) => void waits.push(ms))).status).toBe(503);
    expect(waits).toEqual([2000, 8000]);
  });
});
