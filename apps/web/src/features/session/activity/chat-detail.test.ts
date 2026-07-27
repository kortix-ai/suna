import { describe, expect, test } from 'bun:test';

import { densityForDetail } from './chat-detail';

describe('densityForDetail', () => {
  test('narrative is the folded reading — every adjacent run collapses', () => {
    expect(densityForDetail('narrative')).toBe('simple');
  });

  test('"show full history" maps to the per-kind step list, not to raw output', () => {
    // 'detailed' groups like-with-like and still humanizes each row. Full
    // history means every step is visible and in order — it does NOT mean
    // reverting to the raw `$ cd /workspace && …` wall this work removed.
    expect(densityForDetail('full')).toBe('detailed');
  });
});
